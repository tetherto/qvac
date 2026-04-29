import type { Tool, ToolDialect } from "@/schemas";
import { detectToolDialectFromName } from "@/server/utils/tools";
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
