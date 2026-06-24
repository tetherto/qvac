import { getServerLogger } from "@/logging";

const logger = getServerLogger();

interface ChatMessage {
  role?: string;
  content?: string;
  type?: string;
  name?: string;
}

function formatMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role || m.type || "?";
      const content = m.content
        ? m.content.length > 40
          ? m.content.substring(0, 40) + "..."
          : m.content
        : m.name || "(no content)";
      return `{${role}: "${content}"}`;
    })
    .join(", ");
}

export function logCacheStatus(cacheKey: string, isReusing: boolean): void {
  const status = isReusing ? "REUSING" : "CREATING";
  logger.debug(`[kv-cache] [${cacheKey}] ${status} cache`);
}

export function logCacheInit(
  cacheKey: string,
  systemPrompt: string,
  toolCount: number,
): void {
  const promptLen = systemPrompt.length;
  logger.debug(
    `[kv-cache] [${cacheKey}] Initializing cache (prompt: ${promptLen} chars, tools: ${toolCount})`,
  );
}

export function logMessagesToAddon(
  messages: unknown[],
  phase: "CACHE_INIT" | "PROMPT_SEND" | "NO_CACHE" = "PROMPT_SEND",
): void {
  const typedMessages = messages as ChatMessage[];
  logger.debug(
    `[kv-cache] [${phase}] Sending ${typedMessages.length} msg(s): [${formatMessages(typedMessages)}]`,
  );
}

export function logCacheDisabled(): void {
  logger.debug("[kv-cache] Cache disabled");
}

export function logCacheSave(sessionPath: string): void {
  logger.debug(`[kv-cache] Saving session: ...${sessionPath.slice(-20)}`);
}

export function logCacheSaveError(sessionPath: string, err: unknown): void {
  logger.warn(
    `[kv-cache] Failed to save session: ...${sessionPath.slice(-20)} — ${err instanceof Error ? err.message : String(err)}`,
  );
}
