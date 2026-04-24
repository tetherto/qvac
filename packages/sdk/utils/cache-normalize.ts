// Shared by the auto-cache writer and reader on the server, and surfaced to
// clients as `final.cacheableAssistantContent` so the next turn's `history`
// produces a stable cache key.

// Case-insensitive in case a model variant emits `<Think>`; the addon uses
// lowercase today but we don't want a casing change to regress hit-rate.
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

// Trailing unclosed `<think>...` when a stop token interrupts mid-thought.
// Must run after THINK_BLOCK_RE so only a genuinely unclosed tail matches.
const UNCLOSED_TRAILING_THINK_RE = /<think>[\s\S]*$/i;

/**
 * Canonicalize assistant message text for the auto-cache key.
 *
 * The server saves raw stream text (with think tags when `captureThinking` is
 * on), while `final.contentText` only aggregates `contentDelta` events.
 * Stripping think blocks (paired and unclosed-trailing) and trimming lets
 * callers push back either shape and still hit the cache.
 */
export function normalizeAssistantCacheContent(content: string): string {
  return content
    .replace(THINK_BLOCK_RE, "")
    .replace(UNCLOSED_TRAILING_THINK_RE, "")
    .trim();
}
