import type {
  CompletionEvent,
  CompletionError,
  CompletionStats,
  NormalizerConfig,
  StopReason,
  ToolCall,
} from "@/schemas";
import { parseToolCalls } from "@/server/utils/tools";

type NormalizerState =
  | "content"
  | "thinkingFraming"
  | "toolFraming"
  | "contentFraming";

type FrameSpec = {
  open: string;
  close: string;
};

// Always-stripped protocol markers emitted by the model's chat template.
// The capture-gated `<think>` convention lives separately (BUILTIN_THINKING).
type DialectSpec = {
  // Tool-call frames — parsed via `parseToolCalls(_, dialect)`.
  toolFrames: readonly FrameSpec[];
  // Reasoning frames stripped unconditionally; inner emitted as
  // `thinkingDelta` when `captureThinking` is true.
  thinkingFrames?: readonly FrameSpec[];
  // Content-unwrap frames — inner streamed as `contentDelta`; trailing
  // partial-close tail buffered until resolved.
  contentFrames?: readonly FrameSpec[];
  // Standalone glue tokens stripped without state transition.
  dropTokens?: readonly string[];
};

type Dialect = NonNullable<NormalizerConfig["toolDialect"]>;

const DIALECT_SPECS: Record<Dialect, DialectSpec> = {
  hermes: {
    toolFrames: [{ open: "<tool_call>", close: "</tool_call>" }],
  },
  // No streaming framing — tool calls are only recovered at finalization.
  json: {
    toolFrames: [],
  },
  pythonic: {
    toolFrames: [
      { open: "<|tool_call_start|>", close: "<|tool_call_end|>" },
      {
        open: "<|start_header_id|>tool_call<|end_header_id|>",
        close: "<|eot_id|>",
      },
    ],
  },
  harmony: {
    toolFrames: [
      { open: "<|channel|>commentary to=functions.", close: "<|call|>" },
    ],
    thinkingFrames: [
      { open: "<|channel|>analysis<|message|>", close: "<|end|>" },
    ],
    contentFrames: [
      { open: "<|channel|>final<|message|>", close: "<|return|>" },
    ],
    // Role headers between channel frames + stray `<|return|>` closes.
    dropTokens: [
      "<|start|>assistant",
      "<|start|>system",
      "<|start|>user",
      "<|return|>",
    ],
  },
};

// Capture-gated reasoning marker — the generic `<think>...</think>`
// convention used by reasoning-tuned models. When the gate is off the
// markers pass through into `contentDelta` unchanged (preserves the
// pre-dialect behavior).
const BUILTIN_THINKING: FrameSpec = { open: "<think>", close: "</think>" };

type FrameKind = "tool" | "thinking" | "content";

export type CompletionNormalizer = ReturnType<typeof createCompletionNormalizer>;

export function createCompletionNormalizer(config: NormalizerConfig) {
  let seq = 0;
  let state: NormalizerState = "content";
  let rawText = "";
  const contentParts: string[] = [];
  const thinkingParts: string[] = [];

  // Tool frame: buffer keeps the open + close markers in place so
  // `parseToolCalls` can match its own dialect markers.
  let toolCallBuffer = "";
  let activeToolFrame: FrameSpec | null = null;

  // Thinking frame: tracks which frame's close marker we're scanning for
  // (could be the built-in `<think>` or a dialect-specific frame like
  // Harmony's `<|channel|>analysis<|message|>...<|end|>`).
  let activeThinkingFrame: FrameSpec | null = null;

  // Content frame: inner streamed as it arrives; partial close tail buffered.
  let activeContentFrame: FrameSpec | null = null;

  // Trailing chars that could be a prefix of a watched marker, so markers
  // split across token pushes aren't missed by indexOf.
  let contentTail = "";
  let toolFramingTail = "";
  let thinkingFramingTail = "";
  let contentFramingTail = "";

  const streamedToolCallKeys = new Set<string>();

  const toolsEnabled =
    config.tools.length > 0 && config.capabilities.toolCalling !== "none";
  const useToolFraming =
    toolsEnabled && config.capabilities.toolCalling === "textParse";
  // Register `<think>` only when both capability + capture opt in.
  // Dialect protocol markers always register; capture only gates emission.
  const useBuiltinThinkTags =
    config.captureThinking &&
    config.capabilities.thinkingFraming === "thinkTags";

  const dialect: Dialect = config.toolDialect ?? "hermes";
  const dialectSpec = DIALECT_SPECS[dialect];

  const toolFrames: readonly FrameSpec[] = useToolFraming
    ? dialectSpec.toolFrames
    : [];
  const thinkingFrames: readonly FrameSpec[] = [
    ...(useBuiltinThinkTags ? [BUILTIN_THINKING] : []),
    ...(dialectSpec.thinkingFrames ?? []),
  ];
  const contentFrames: readonly FrameSpec[] = dialectSpec.contentFrames ?? [];
  const dropTokens: readonly string[] = dialectSpec.dropTokens ?? [];

  const markerToEntry = new Map<string, { kind: FrameKind; spec: FrameSpec }>();
  const dropTokenSet = new Set<string>();
  const contentMarkers: string[] = [];
  function registerFrames(frames: readonly FrameSpec[], kind: FrameKind) {
    for (const f of frames) {
      if (markerToEntry.has(f.open)) continue;
      markerToEntry.set(f.open, { kind, spec: f });
      contentMarkers.push(f.open);
    }
  }
  registerFrames(toolFrames, "tool");
  registerFrames(thinkingFrames, "thinking");
  registerFrames(contentFrames, "content");
  for (const t of dropTokens) {
    if (markerToEntry.has(t) || dropTokenSet.has(t)) continue;
    dropTokenSet.add(t);
    contentMarkers.push(t);
  }

  function nextSeq() {
    return seq++;
  }

  function emitContent(events: CompletionEvent[], text: string) {
    if (!text) return;
    contentParts.push(text);
    events.push({ type: "contentDelta", seq: nextSeq(), text });
  }

  // Capture-gated: thinking frames may register even when `captureThinking`
  // is false (e.g. harmony's analysis channel, to strip markers from
  // `contentDelta`) — drop the inner here instead of buffering it.
  function emitThinking(events: CompletionEvent[], text: string) {
    if (!text) return;
    if (config.captureThinking) {
      thinkingParts.push(text);
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
    const frame = activeToolFrame;
    toolCallBuffer = "";
    activeToolFrame = null;
    toolFramingTail = "";

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

  function getStateTail() {
    switch (state) {
      case "content":
        return contentTail;
      case "thinkingFraming":
        return thinkingFramingTail;
      case "toolFraming":
        return toolFramingTail;
      case "contentFraming":
        return contentFramingTail;
    }
  }

  function processSegment(events: CompletionEvent[], text: string) {
    let buf = getStateTail() + text;

    contentTail = "";
    thinkingFramingTail = "";
    toolFramingTail = "";
    contentFramingTail = "";

    while (buf.length > 0) {
      if (state === "toolFraming") {
        if (!activeToolFrame) {
          state = "content";
          continue;
        }

        const hit = buf.indexOf(activeToolFrame.close);

        if (hit >= 0) {
          toolCallBuffer += buf.slice(0, hit + activeToolFrame.close.length);
          buf = buf.slice(hit + activeToolFrame.close.length);
          state = "content";
          flushToolBuffer(events, true);
          continue;
        }

        const tailLen = trailingPartialMarkerLen(buf, [activeToolFrame.close]);
        const safeLen = buf.length - tailLen;
        toolCallBuffer += buf.slice(0, safeLen);
        toolFramingTail = buf.slice(safeLen);
        buf = "";
        continue;
      }

      if (state === "thinkingFraming") {
        if (!activeThinkingFrame) {
          state = "content";
          continue;
        }
        const closeMarker = activeThinkingFrame.close;
        const closeIdx = buf.indexOf(closeMarker);
        if (closeIdx >= 0) {
          emitThinking(events, buf.slice(0, closeIdx));
          buf = buf.slice(closeIdx + closeMarker.length);
          activeThinkingFrame = null;
          state = "content";
          continue;
        }
        const tailLen = trailingPartialMarkerLen(buf, [closeMarker]);
        const safeLen = buf.length - tailLen;
        emitThinking(events, buf.slice(0, safeLen));
        thinkingFramingTail = buf.slice(safeLen);
        buf = "";
        continue;
      }

      if (state === "contentFraming") {
        if (!activeContentFrame) {
          state = "content";
          continue;
        }
        const closeMarker = activeContentFrame.close;
        const closeIdx = buf.indexOf(closeMarker);
        if (closeIdx >= 0) {
          emitContent(events, buf.slice(0, closeIdx));
          activeContentFrame = null;
          contentFramingTail = "";
          buf = buf.slice(closeIdx + closeMarker.length);
          state = "content";
          continue;
        }
        const tailLen = trailingPartialMarkerLen(buf, [closeMarker]);
        const safeLen = buf.length - tailLen;
        emitContent(events, buf.slice(0, safeLen));
        contentFramingTail = buf.slice(safeLen);
        buf = "";
        continue;
      }

      const hit = findEarliestMarker(buf, contentMarkers);
      if (hit) {
        emitContent(events, buf.slice(0, hit.idx));
        buf = buf.slice(hit.idx + hit.marker.length);

        if (dropTokenSet.has(hit.marker)) {
          // Glue token between frames — strip and stay in content state.
          continue;
        }

        const entry = markerToEntry.get(hit.marker)!;
        if (entry.kind === "tool") {
          toolCallBuffer = hit.marker;
          activeToolFrame = entry.spec;
          state = "toolFraming";
        } else if (entry.kind === "thinking") {
          activeThinkingFrame = entry.spec;
          state = "thinkingFraming";
        } else {
          activeContentFrame = entry.spec;
          state = "contentFraming";
        }
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
    } else if (state === "thinkingFraming" && thinkingFramingTail) {
      emitThinking(events, thinkingFramingTail);
      thinkingFramingTail = "";
    } else if (state === "toolFraming" && toolFramingTail) {
      toolCallBuffer += toolFramingTail;
      toolFramingTail = "";
    } else if (state === "contentFraming" && contentFramingTail) {
      // Cutoff inside a partial close marker — emit tail as content.
      emitContent(events, contentFramingTail);
      contentFramingTail = "";
    }

    if (state === "toolFraming" && activeToolFrame) {
      if (opts?.error) {
        emitContent(events, toolCallBuffer);
        toolCallBuffer = "";
        activeToolFrame = null;
      } else {
        flushToolBuffer(events, false);
      }
    } else if (state === "contentFraming") {
      activeContentFrame = null;
    }
    activeThinkingFrame = null;
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
