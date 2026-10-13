/**
 * Pure commit decision for kv-cache turns used by `completion-stream.ts`.
 *
 * This module intentionally has **no** `bare-*` imports so it can be
 * exercised directly from unit tests running under `bun` without
 * pulling in the Bare runtime (which is not available in that
 * environment).
 */

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
