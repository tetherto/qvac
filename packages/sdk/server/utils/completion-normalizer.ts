import type {
  CompletionEvent,
  CompletionError,
  CompletionStats,
  NormalizerConfig,
  StopReason,
  ToolCall,
} from "@/schemas";
import { parseToolCalls } from "@/server/utils/tools";

type NormalizerState = "content" | "thinking" | "toolBuffering";

type FrameSpec = {
  open: string;
  close: string;
};

type DialectSpec = {
  frames: readonly FrameSpec[];
};

type Dialect = NonNullable<NormalizerConfig["toolDialect"]>;

const DIALECT_SPECS: Record<Dialect, DialectSpec> = {
  hermes: {
    frames: [{ open: "<tool_call>", close: "</tool_call>" }],
  },
  // No streaming framing — tool calls are only recovered at finalization.
  json: {
    frames: [],
  },
  pythonic: {
    frames: [
      { open: "<|tool_call_start|>", close: "<|tool_call_end|>" },
      {
        open: "<|start_header_id|>tool_call<|end_header_id|>",
        close: "<|eot_id|>",
      },
    ],
  },
};

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export type CompletionNormalizer = ReturnType<typeof createCompletionNormalizer>;

export function createCompletionNormalizer(config: NormalizerConfig) {
  let seq = 0;
  let state: NormalizerState = "content";
  let rawText = "";
  const contentParts: string[] = [];
  const thinkingParts: string[] = [];

  // Frame buffer keeps the open + close markers in place so parseToolCalls
  // can match its own dialect markers.
  let toolCallBuffer = "";
  let activeFrame: FrameSpec | null = null;

  // Trailing chars that could be a prefix of a watched marker, so markers
  // split across token pushes aren't missed by indexOf.
  let contentTail = "";
  let toolTail = "";
  let thinkingTail = "";

  const streamedToolCallKeys = new Set<string>();

  const toolsEnabled =
    config.tools.length > 0 && config.capabilities.toolCalling !== "none";
  const useFramedParsing =
    toolsEnabled && config.capabilities.toolCalling === "textParse";
  const useThinkingParsing =
    config.captureThinking && config.capabilities.thinkingFraming === "thinkTags";

  const dialect: Dialect = config.toolDialect ?? "hermes";
  const dialectSpec = DIALECT_SPECS[dialect];
  const frameSpecs = useFramedParsing ? dialectSpec.frames : [];

  const contentMarkers: string[] = [];
  if (useThinkingParsing) contentMarkers.push(THINK_OPEN);
  for (const f of frameSpecs) contentMarkers.push(f.open);

  function nextSeq() {
    return seq++;
  }

  function emitContent(events: CompletionEvent[], text: string) {
    if (!text) return;
    contentParts.push(text);
    events.push({ type: "contentDelta", seq: nextSeq(), text });
  }

  function emitThinking(events: CompletionEvent[], text: string) {
    if (!text) return;
    thinkingParts.push(text);
    if (config.captureThinking) {
      events.push({ type: "thinkingDelta", seq: nextSeq(), text });
    }
  }

  function getToolCallKey(call: ToolCall) {
    return `${call.name}:${JSON.stringify(call.arguments)}`;
  }

  function emitStreamedToolCall(events: CompletionEvent[], call: ToolCall) {
    streamedToolCallKeys.add(getToolCallKey(call));
    events.push({ type: "toolCall", seq: nextSeq(), call });
  }

  function emitFinalToolCall(events: CompletionEvent[], call: ToolCall) {
    if (streamedToolCallKeys.has(getToolCallKey(call))) return;
    events.push({ type: "toolCall", seq: nextSeq(), call });
  }

  // Length of the longest suffix of `buf` that is also a prefix of any marker.
  function trailingPartialMarkerLen(buf: string, markers: readonly string[]) {
    if (markers.length === 0 || buf.length === 0) return 0;
    const maxLen = Math.min(
      buf.length,
      markers.reduce((m, s) => Math.max(m, s.length), 0) - 1,
    );
    for (let len = maxLen; len > 0; len--) {
      const suffix = buf.slice(buf.length - len);
      for (const m of markers) {
        if (m.startsWith(suffix)) return len;
      }
    }
    return 0;
  }

  type EarliestMatch = { idx: number; marker: string };
  function findEarliestMarker(
    buf: string,
    markers: readonly string[],
  ): EarliestMatch | null {
    let best: EarliestMatch | null = null;
    for (const m of markers) {
      const i = buf.indexOf(m);
      if (i < 0) continue;
      if (best === null || i < best.idx) best = { idx: i, marker: m };
    }
    return best;
  }

  function flushToolBuffer(events: CompletionEvent[], closed: boolean) {
    const raw = toolCallBuffer;
    const frame = activeFrame;
    toolCallBuffer = "";
    activeFrame = null;
    toolTail = "";

    if (!frame) return;

    // Empty-payload guard. Strip frame markers and check the inner is
    // non-empty; surface a toolError on empty payloads so the literal
    // markers don't leak into contentDelta.
    let inner = raw;
    if (inner.startsWith(frame.open)) inner = inner.slice(frame.open.length);
    if (inner.endsWith(frame.close)) {
      inner = inner.slice(0, inner.length - frame.close.length);
    }
    if (inner.trim().length === 0) {
      events.push({
        type: "toolError",
        seq: nextSeq(),
        error: { code: "PARSE_ERROR", message: "Empty tool_call frame" },
      });
      return;
    }

    const { toolCalls, errors } = parseToolCalls(raw, config.tools, dialect);

    for (const call of toolCalls) emitStreamedToolCall(events, call);

    if (toolCalls.length === 0) {
      if (errors.length > 0) {
        for (const error of errors) {
          events.push({ type: "toolError", seq: nextSeq(), error });
        }
      } else {
        events.push({
          type: "toolError",
          seq: nextSeq(),
          error: {
            code: "PARSE_ERROR",
            message: closed
              ? "Failed to parse tool call from framed region"
              : "Incomplete tool call frame at stream end",
            raw,
          },
        });
      }
      emitContent(events, raw);
    }
  }

  function processSegment(events: CompletionEvent[], text: string) {
    let buf =
      (state === "content"
        ? contentTail
        : state === "thinking"
          ? thinkingTail
          : toolTail) + text;

    contentTail = "";
    thinkingTail = "";
    toolTail = "";

    while (buf.length > 0) {
      if (state === "toolBuffering") {
        if (!activeFrame) {
          state = "content";
          continue;
        }

        const hit = buf.indexOf(activeFrame.close);

        if (hit >= 0) {
          toolCallBuffer += buf.slice(0, hit + activeFrame.close.length);
          buf = buf.slice(hit + activeFrame.close.length);
          state = "content";
          flushToolBuffer(events, true);
          continue;
        }

        const tailLen = trailingPartialMarkerLen(buf, [activeFrame.close]);
        const safeLen = buf.length - tailLen;
        toolCallBuffer += buf.slice(0, safeLen);
        toolTail = buf.slice(safeLen);
        buf = "";
        continue;
      }

      if (state === "thinking") {
        const closeIdx = buf.indexOf(THINK_CLOSE);
        if (closeIdx >= 0) {
          emitThinking(events, buf.slice(0, closeIdx));
          buf = buf.slice(closeIdx + THINK_CLOSE.length);
          state = "content";
          continue;
        }
        const tailLen = trailingPartialMarkerLen(buf, [THINK_CLOSE]);
        const safeLen = buf.length - tailLen;
        emitThinking(events, buf.slice(0, safeLen));
        thinkingTail = buf.slice(safeLen);
        buf = "";
        continue;
      }

      const hit = findEarliestMarker(buf, contentMarkers);
      if (hit) {
        emitContent(events, buf.slice(0, hit.idx));

        if (hit.marker === THINK_OPEN) {
          buf = buf.slice(hit.idx + hit.marker.length);
          state = "thinking";
          continue;
        }

        const spec = frameSpecs.find((f) => f.open === hit.marker)!;
        toolCallBuffer = hit.marker;
        activeFrame = spec;
        buf = buf.slice(hit.idx + hit.marker.length);
        state = "toolBuffering";
        continue;
      }

      const tailLen = trailingPartialMarkerLen(buf, contentMarkers);
      const safeLen = buf.length - tailLen;
      emitContent(events, buf.slice(0, safeLen));
      contentTail = buf.slice(safeLen);
      buf = "";
    }
  }

  function push(token: string): CompletionEvent[] {
    const events: CompletionEvent[] = [];
    rawText += token;

    if (config.emitRawDeltas) {
      events.push({ type: "rawDelta", seq: nextSeq(), text: token });
    }

    processSegment(events, token);
    return events;
  }

  function finish(opts?: {
    stats?: CompletionStats;
    toolCalls?: ToolCall[];
    error?: CompletionError;
    stopReason?: StopReason;
  }): CompletionEvent[] {
    const events: CompletionEvent[] = [];

    // Drain pending tail bytes so we don't lose trailing chars when the
    // stream ends mid-marker.
    if (state === "content" && contentTail) {
      emitContent(events, contentTail);
      contentTail = "";
    } else if (state === "thinking" && thinkingTail) {
      emitThinking(events, thinkingTail);
      thinkingTail = "";
    } else if (state === "toolBuffering" && toolTail) {
      toolCallBuffer += toolTail;
      toolTail = "";
    }

    if (state === "toolBuffering" && activeFrame) {
      if (opts?.error) {
        emitContent(events, toolCallBuffer);
        toolCallBuffer = "";
        activeFrame = null;
      } else {
        flushToolBuffer(events, false);
      }
    }
    state = "content";

    if (!opts?.error) {
      if (opts?.toolCalls) {
        for (const call of opts.toolCalls) {
          emitFinalToolCall(events, call);
        }
      }
    }

    if (opts?.stats) {
      events.push({
        type: "completionStats",
        seq: nextSeq(),
        stats: opts.stats,
      });
    }

    const raw = { fullText: rawText };

    if (opts?.error) {
      events.push({
        type: "completionDone",
        seq: nextSeq(),
        stopReason: "error",
        error: opts.error,
        raw,
      });
    } else if (opts?.stopReason) {
      events.push({
        type: "completionDone",
        seq: nextSeq(),
        stopReason: opts.stopReason,
        raw,
      });
    } else {
      events.push({ type: "completionDone", seq: nextSeq(), raw });
    }

    return events;
  }

  function getAccumulated() {
    return {
      rawText,
      contentText: contentParts.join(""),
      thinkingText:
        thinkingParts.length > 0 ? thinkingParts.join("") : undefined,
    };
  }

  return { push, finish, getAccumulated };
}
