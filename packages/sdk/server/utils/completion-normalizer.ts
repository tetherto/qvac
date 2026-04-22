import type {
  CompletionEvent,
  CompletionError,
  CompletionStats,
  NormalizerConfig,
  StopReason,
  ToolCall,
} from "@/schemas";
import { parseToolCalls } from "@/server/utils/tool-parser";

type NormalizerState = "content" | "thinking" | "toolBuffering";

export type CompletionNormalizer = ReturnType<typeof createCompletionNormalizer>;

export function createCompletionNormalizer(config: NormalizerConfig) {
  let seq = 0;
  let state: NormalizerState = "content";
  let rawText = "";
  const contentParts: string[] = [];
  const thinkingParts: string[] = [];
  let toolCallBuffer = "";
  let toolFrameOpen = false;
  const streamedToolCallKeys = new Set<string>();

  const toolsEnabled =
    config.tools.length > 0 && config.capabilities.toolCalling !== "none";
  const useFramedParsing = toolsEnabled && config.capabilities.toolCalling === "textParse";
  const useThinkingParsing =
    config.captureThinking && config.capabilities.thinkingFraming === "thinkTags";

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

  // Only dedupes against already-streamed calls; repeated calls within finish() are preserved.
  function emitFinalToolCall(events: CompletionEvent[], call: ToolCall) {
    if (streamedToolCallKeys.has(getToolCallKey(call))) return;
    events.push({ type: "toolCall", seq: nextSeq(), call });
  }

  function flushToolBuffer(events: CompletionEvent[], closed: boolean) {
    const raw = closed
      ? `<tool_call>${toolCallBuffer}</tool_call>`
      : `<tool_call>${toolCallBuffer}`;

    if (!toolCallBuffer.trim()) {
      events.push({
        type: "toolError",
        seq: nextSeq(),
        error: { code: "PARSE_ERROR", message: "Empty tool_call frame" },
      });
      emitContent(events, raw);
      toolCallBuffer = "";
      toolFrameOpen = false;
      return;
    }

    const { toolCalls, errors } = parseToolCalls(
      toolCallBuffer,
      config.tools,
    );

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
            message: "Failed to parse tool call from framed region",
            raw: toolCallBuffer,
          },
        });
      }
      emitContent(events, raw);
    }

    toolCallBuffer = "";
    toolFrameOpen = false;
  }

  function processSegment(events: CompletionEvent[], text: string) {
    let remaining = text;

    while (remaining.length > 0) {
      if (state === "toolBuffering") {
        const closeIdx = remaining.indexOf("</tool_call>");
        if (closeIdx >= 0) {
          toolCallBuffer += remaining.slice(0, closeIdx);
          remaining = remaining.slice(closeIdx + "</tool_call>".length);
          state = "content";
          flushToolBuffer(events, true);
        } else {
          toolCallBuffer += remaining;
          remaining = "";
        }
      } else if (state === "thinking") {
        const closeIdx = remaining.indexOf("</think>");
        if (closeIdx >= 0) {
          emitThinking(events, remaining.slice(0, closeIdx));
          remaining = remaining.slice(closeIdx + "</think>".length);
          state = "content";
        } else {
          emitThinking(events, remaining);
          remaining = "";
        }
      } else {
        const thinkIdx = useThinkingParsing ? remaining.indexOf("<think>") : -1;
        const toolIdx = useFramedParsing
          ? remaining.indexOf("<tool_call>")
          : -1;

        const candidates: { idx: number; tag: "think" | "tool" }[] = [];
        if (thinkIdx >= 0) candidates.push({ idx: thinkIdx, tag: "think" });
        if (toolIdx >= 0) candidates.push({ idx: toolIdx, tag: "tool" });
        candidates.sort((a, b) => a.idx - b.idx);

        const first = candidates[0];
        if (first) {
          emitContent(events, remaining.slice(0, first.idx));
          if (first.tag === "think") {
            remaining = remaining.slice(first.idx + "<think>".length);
            state = "thinking";
          } else {
            remaining = remaining.slice(first.idx + "<tool_call>".length);
            state = "toolBuffering";
            toolCallBuffer = "";
            toolFrameOpen = true;
          }
        } else {
          emitContent(events, remaining);
          remaining = "";
        }
      }
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

    if (state === "toolBuffering" && toolFrameOpen) {
      if (opts?.error) {
        emitContent(events, `<tool_call>${toolCallBuffer}`);
        toolCallBuffer = "";
        toolFrameOpen = false;
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
