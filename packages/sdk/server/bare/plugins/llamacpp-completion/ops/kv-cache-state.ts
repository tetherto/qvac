/**
 * Pure decision helper for kv-cache history slicing used by
 * `completion-stream.ts` (via the slice computed from
 * `TurnHandle.savedCount`).
 *
 * This module intentionally has **no** `bare-*` imports so it can be
 * exercised directly from unit tests running under `bun` without
 * pulling in the Bare runtime (which is not available in that
 * environment).
 *
 * Cancel detection flows through the per-request `AbortSignal` from
 * `RequestRegistry`; the `cachedMessageCounts` map lives in
 * `kv-cache-session.ts`, which owns all three KV-cache bookkeeping
 * layers (saved counts, init flags, on-disk files). Only the pure
 * slice-decision helper remains here.
 */

export interface HistoryMessage {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
}

export interface HistorySliceDecision {
  /** Messages to send to the model on the next turn. */
  messages: HistoryMessage[];
  /**
   * True when the decision path proves the current `savedCount` is stale
   * and the caller should drop the cached entry (via
   * `KvCacheSession.dropStaleSavedCount(turn)`) to avoid propagating the
   * bad count to the next turn.
   */
  clearStaleCount: boolean;
}

/**
 * Pure slice decision for `prepareMessagesForCache`.
 *
 * Mirrors the shape of the logic in `completion-stream.ts` but without
 * calling `transformMessages` (which depends on `bare-fs` for
 * attachment probing). Kept here so the decision can be unit-tested in
 * isolation.
 *
 * The key regression guard: when a non-zero `savedCount` would slice
 * the history down to an empty array, it is treated as stale — the
 * caller falls back to sending the system-stripped full history rather
 * than handing the model an empty payload.
 */
export function decideCachedHistorySlice(
  savedCount: number,
  cacheExists: boolean,
  history: HistoryMessage[],
): HistorySliceDecision {
  if (!cacheExists || history.length === 0) {
    return {
      messages: history.filter((msg) => msg.role !== "system"),
      clearStaleCount: false,
    };
  }

  const canSlice = savedCount > 0 && savedCount <= history.length;
  const sliced = canSlice ? history.slice(savedCount) : null;

  // A non-null slice that is empty means the saved count is stale: the
  // cached turn boundary is claiming the entire current history is
  // already cached, which happens when a previous turn was cancelled
  // mid-decode and still recorded `history.length + 1`. Treat it as a
  // bad state and resend the full (system-stripped) history.
  const useSlice = sliced !== null && sliced.length > 0;
  const messages = useSlice
    ? sliced
    : history.filter((msg) => msg.role !== "system");

  return {
    messages,
    clearStaleCount: !useSlice && savedCount > 0,
  };
}
