import type { Tool } from "@/schemas";
import type { ToolCallEvent } from "@/schemas/tools";
import {
  parseToolCalls,
  convertToolsToGrammar,
} from "@/server/utils/tool-parser";

interface HistoryMessage {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
}

export function insertToolsIntoHistory(
  history: HistoryMessage[],
  tools: Tool[],
): Array<HistoryMessage | Tool> {
  const systemMsgIndex = history.findIndex((msg) => msg.role === "system");

  if (systemMsgIndex >= 0) {
    return [
      ...history.slice(0, systemMsgIndex + 1),
      ...tools,
      ...history.slice(systemMsgIndex + 1),
    ];
  }

  return [...tools, ...history];
}

export function setupToolGrammar(
  modelConfig: Record<string, unknown>,
  tools: Tool[],
) {
  const grammar = convertToolsToGrammar(tools);
  modelConfig["grammar"] = grammar;
}

function isInsideThinkBlock(text: string): boolean {
  const lastOpen = text.lastIndexOf("<think>");
  if (lastOpen === -1) return false;
  const lastClose = text.lastIndexOf("</think>");
  return lastClose < lastOpen;
}

export function checkForToolEvents(
  accumulatedText: string,
  currentToken: string,
  tools: Tool[],
  emittedToolCallPositions: Set<number>,
): ToolCallEvent[] {
  const events: ToolCallEvent[] = [];

  if (isInsideThinkBlock(accumulatedText)) {
    return events;
  }

  if (currentToken.includes("</tool_call>") || currentToken.includes("}")) {
    const { toolCalls, errors } = parseToolCalls(accumulatedText, tools);

    for (const call of toolCalls) {
      const callPosition = accumulatedText.indexOf(call.raw || "");
      if (callPosition >= 0 && !emittedToolCallPositions.has(callPosition)) {
        emittedToolCallPositions.add(callPosition);
        events.push({
          type: "toolCall",
          call,
        });
      }
    }

    for (const error of errors) {
      const errorPosition = accumulatedText.indexOf(error.raw || "");
      if (errorPosition >= 0 && !emittedToolCallPositions.has(errorPosition)) {
        emittedToolCallPositions.add(errorPosition);
        events.push({
          type: "toolCallError",
          error,
        });
      }
    }
  }

  return events;
}
