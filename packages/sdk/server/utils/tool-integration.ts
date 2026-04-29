import type { Tool, ToolCall, ToolCallError, ToolDialect } from "@/schemas";
import type { ToolCallEvent } from "@/schemas/tools";
import {
  parseToolCalls,
  detectToolDialectFromName,
} from "@/server/utils/tools";
import { getModelInfo } from "@/server/bare/registry/model-registry";

interface HistoryMessage {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
}

/**
 * Static tools mode: prepend tools right after the system message (or at the
 * very start when no system message is present). The tool block stays in the
 * kv-cache for the whole chat session.
 */
export function prependToolsToHistory(
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

/**
 * Dynamic tools mode: append tools after the last history message. The
 * addon's compact-tools mode anchors the block after the last user message
 * and trims it from the kv-cache once the tool-call chain resolves, so a
 * subsequent turn can ship a different tool set without poisoning the cache.
 */
export function appendToolsToHistory(
  history: HistoryMessage[],
  tools: Tool[],
): Array<HistoryMessage | Tool> {
  return [...history, ...tools];
}

export function detectToolDialect(modelId: string): ToolDialect {
  const info = getModelInfo(modelId);
  if (!info) return "hermes";
  return detectToolDialectFromName(info.name, info.path);
}

function isInsideThinkBlock(text: string): boolean {
  const lastOpen = text.lastIndexOf("<think>");
  if (lastOpen === -1) return false;
  const lastClose = text.lastIndexOf("</think>");
  return lastClose < lastOpen;
}

// Cheap per-token gate before attempting a full parse.
function tokenLooksLikeFrameClose(
  token: string,
  dialect: ToolDialect | undefined,
): boolean {
  switch (dialect) {
    case "pythonic":
      return (
        token.includes("<|tool_call_end|>") ||
        token.includes("<|eot_id|>") ||
        token.includes("]")
      );
    case "json":
      return token.includes("}");
    case "hermes":
    default:
      return token.includes("</tool_call>") || token.includes("}");
  }
}

// Dedupe key = content + per-call occurrence, so legitimate repeats like
// `[f(x=1), f(x=1)]` each emit once while re-parses on later tokens don't.
function toolCallBase(call: ToolCall): string {
  return `call:${call.name}:${JSON.stringify(call.arguments)}`;
}

function toolErrorBase(error: ToolCallError): string {
  return `err:${error.code}:${error.raw ?? ""}:${error.message}`;
}

export function checkForToolEvents(
  accumulatedText: string,
  currentToken: string,
  tools: Tool[],
  emittedToolCallKeys: Set<string>,
  dialect?: ToolDialect,
): ToolCallEvent[] {
  const events: ToolCallEvent[] = [];

  if (isInsideThinkBlock(accumulatedText)) {
    return events;
  }

  if (!tokenLooksLikeFrameClose(currentToken, dialect)) {
    return events;
  }

  const { toolCalls, errors } = parseToolCalls(
    accumulatedText,
    tools,
    dialect,
  );

  const localCounts = new Map<string, number>();

  for (const call of toolCalls) {
    const base = toolCallBase(call);
    const occurrence = (localCounts.get(base) ?? 0) + 1;
    localCounts.set(base, occurrence);
    const key = `${base}#${occurrence}`;
    if (emittedToolCallKeys.has(key)) continue;
    emittedToolCallKeys.add(key);
    events.push({ type: "toolCall", call });
  }

  for (const error of errors) {
    const base = toolErrorBase(error);
    const occurrence = (localCounts.get(base) ?? 0) + 1;
    localCounts.set(base, occurrence);
    const key = `${base}#${occurrence}`;
    if (emittedToolCallKeys.has(key)) continue;
    emittedToolCallKeys.add(key);
    events.push({ type: "toolCallError", error });
  }

  return events;
}
