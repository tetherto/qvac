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
  role: string
  content: string
  attachments?: { path: string }[] | undefined
}

export interface HistorySliceDecision {
  /** Messages to send to the model on the next turn. */
  messages: HistoryMessage[]
  /**
   * True when the decision path proves the current `savedCount` is stale
   * and the caller should drop the cached entry (via
   * `KvCacheSession.dropStaleSavedCount(turn)`) to avoid propagating the
   * bad count to the next turn.
   */
  clearStaleCount: boolean
}

interface CacheCommitContext {
  aborted: boolean
  producedTokens: boolean
  generatedTokens?: number | undefined
  predict?: number | undefined
  stoppedAtContextBoundary: boolean
}

export function shouldCommitCachedTurn(context: CacheCommitContext): boolean {
  const { aborted, producedTokens, generatedTokens, predict, stoppedAtContextBoundary } = context
  const stoppedByBudget =
    predict !== undefined &&
    predict > 0 &&
    generatedTokens !== undefined &&
    generatedTokens >= predict

  return !aborted && producedTokens && !stoppedByBudget && !stoppedAtContextBoundary
}

/**
 * Pure slice decision for `prepareMessagesForCache`.
 *
 * Mirrors the shape of the logic in `completion-stream.ts` but without
 * calling `transformMessages` (which depends on `bare-fs` for
 * attachment probing). Kept here so the decision can be unit-tested in
 * isolation.
 *
 * A committed `savedCount` means the cache holds the rendered prefix for that
 * many messages, so slicing from it drops exactly what the cache supplies —
 * the system message among them. Without a usable boundary the cache supplies
 * nothing, so the whole history goes to the addon, system message included:
 * anything held back would simply be missing from the prompt.
 *
 * The regression guard: a non-zero `savedCount` that slices the history down
 * to an empty array is stale, and the caller resends the full history rather
 * than handing the model an empty payload.
 */
export function decideCachedHistorySlice(
  savedCount: number,
  cacheExists: boolean,
  history: HistoryMessage[]
): HistorySliceDecision {
  const hasCachedPrefix = cacheExists && history.length > 0
  const sliced =
    hasCachedPrefix && savedCount > 0 && savedCount <= history.length
      ? history.slice(savedCount)
      : null

  // A non-null slice that is empty means the saved count is stale: the
  // cached turn boundary is claiming the entire current history is
  // already cached, which happens when a previous turn was cancelled
  // mid-decode and still recorded `history.length + 1`. Treat it as a
  // bad state and resend the full history.
  const useSlice = sliced !== null && sliced.length > 0

  return {
    messages: useSlice ? sliced : history,
    // Only a boundary that was actually consulted can be stale. Absent a cache
    // or a history to slice, the count is simply unused and left alone.
    clearStaleCount: hasCachedPrefix && !useSlice && savedCount > 0
  }
}
