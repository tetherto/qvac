import type {
  CompletionError,
  CompletionEvent,
  CompletionFinal,
  CompletionStats,
  ToolCall,
} from "@/schemas";
import { normalizeAssistantCacheContent } from "@/utils/cache-normalize";
import {
  attachHandlersToToolCalls,
  type ToolHandlerMap,
} from "@/utils/tool-helpers";

export type AggregatedEvents = {
  contentText: string;
  thinkingText: string;
  stats: CompletionStats | undefined;
  toolCalls: ToolCall[];
  rawFullText: string | undefined;
  error: CompletionError | undefined;
  /**
   * True when the terminal `completionDone` carried
   * `stopReason: "cancelled"`. The client wrapper rejects the
   * promise-aggregates (`final` / `text` / `toolCalls` / `stats`) with
   * `InferenceCancelledError` carrying the partial state when this is
   * set; the `events` stream itself still ends normally.
   */
  cancelled: boolean;
};

export function aggregateEvents(events: CompletionEvent[]): AggregatedEvents {
  let contentText = "";
  let thinkingText = "";
  let stats: CompletionStats | undefined;
  let rawFullText: string | undefined;
  let error: CompletionError | undefined;
  let cancelled = false;
  const toolCalls: ToolCall[] = [];

  for (const event of events) {
    if (event.type === "contentDelta") {
      contentText += event.text;
    } else if (event.type === "thinkingDelta") {
      thinkingText += event.text;
    } else if (event.type === "completionStats") {
      stats = event.stats;
    } else if (event.type === "toolCall") {
      toolCalls.push(event.call);
    } else if (event.type === "completionDone") {
      if ("raw" in event && event.raw) {
        rawFullText = event.raw.fullText;
      }
      // Error wins over cancelled if a wire event ever carries both
      // signals: a mid-stream addon failure makes the partial state
      // unsafe to expose, regardless of why the loop exited.
      if (event.stopReason === "error" && "error" in event) {
        error = event.error;
      } else if (event.stopReason === "cancelled") {
        cancelled = true;
      }
    }
  }

  return {
    contentText,
    thinkingText,
    stats,
    toolCalls,
    rawFullText,
    error,
    cancelled,
  };
}

export function buildFinalFromEvents(
  events: CompletionEvent[],
  handlers: ToolHandlerMap,
): {
  final: CompletionFinal;
  error: CompletionError | undefined;
  cancelled: boolean;
} {
  const {
    contentText,
    thinkingText,
    stats,
    toolCalls,
    rawFullText,
    error,
    cancelled,
  } = aggregateEvents(events);

  const attachedToolCalls = attachHandlersToToolCalls(toolCalls, handlers);
  const fullText = rawFullText ?? contentText;
  const cacheableAssistantContent =
    attachedToolCalls.length === 0
      ? normalizeAssistantCacheContent(fullText)
      : undefined;

  const final: CompletionFinal = {
    contentText,
    ...(thinkingText && { thinkingText }),
    toolCalls: attachedToolCalls,
    ...(stats && { stats }),
    raw: { fullText },
    ...(cacheableAssistantContent !== undefined && {
      cacheableAssistantContent,
    }),
  };

  return { final, error, cancelled };
}
