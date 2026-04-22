import type {
  CompletionError,
  CompletionEvent,
  CompletionFinal,
  CompletionStats,
  ToolCall,
} from "@/schemas";
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
};

export function aggregateEvents(events: CompletionEvent[]): AggregatedEvents {
  let contentText = "";
  let thinkingText = "";
  let stats: CompletionStats | undefined;
  let rawFullText: string | undefined;
  let error: CompletionError | undefined;
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
      if (event.stopReason === "error" && "error" in event) {
        error = event.error;
      }
    }
  }

  return { contentText, thinkingText, stats, toolCalls, rawFullText, error };
}

export function buildFinalFromEvents(
  events: CompletionEvent[],
  handlers: ToolHandlerMap,
): { final: CompletionFinal; error: CompletionError | undefined } {
  const { contentText, thinkingText, stats, toolCalls, rawFullText, error } =
    aggregateEvents(events);

  const final: CompletionFinal = {
    contentText,
    ...(thinkingText && { thinkingText }),
    toolCalls: attachHandlersToToolCalls(toolCalls, handlers),
    ...(stats && { stats }),
    raw: { fullText: rawFullText ?? contentText },
  };

  return { final, error };
}
