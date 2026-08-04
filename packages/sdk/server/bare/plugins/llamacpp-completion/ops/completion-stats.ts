import type { CompletionStats } from '@/schemas'
import type { LlmStats } from '@/server/bare/types/addon-responses'

function finiteNumber(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

export function normalizeCompletionStats(stats: LlmStats | undefined) {
  if (!stats) return undefined

  const timeToFirstToken = finiteNumber(stats.TTFT)
  const tokensPerSecond = finiteNumber(stats.TPS)
  const cacheTokens = finiteNumber(stats.CacheTokens)
  const promptTokens = finiteNumber(stats.promptTokens)
  const generatedTokens = finiteNumber(stats.generatedTokens)
  const avgConcurrentSeq = finiteNumber(stats.avgConcurrentSeq)

  const normalized: CompletionStats = {
    ...(timeToFirstToken !== undefined && { timeToFirstToken }),
    ...(tokensPerSecond !== undefined && { tokensPerSecond }),
    ...(cacheTokens !== undefined && { cacheTokens }),
    ...(promptTokens !== undefined && { promptTokens }),
    ...(generatedTokens !== undefined && { generatedTokens }),
    ...(avgConcurrentSeq !== undefined && { avgConcurrentSeq }),
    ...(stats.backendDevice !== undefined && { backendDevice: stats.backendDevice })
  }

  if (
    timeToFirstToken === undefined &&
    tokensPerSecond === undefined &&
    cacheTokens === undefined &&
    promptTokens === undefined &&
    generatedTokens === undefined &&
    avgConcurrentSeq === undefined &&
    stats.backendDevice === undefined
  ) {
    return undefined
  }

  return normalized
}

/**
 * Attach the count of non-empty pieces the addon streamed without
 * overwriting `generatedTokens` (`llama_perf` `n_eval`). Length / KV-cache
 * decisions keep the decode count; usage reporting prefers `emittedTokens`.
 * Zero is attached explicitly so inflated `n_eval` cannot be used as usage
 * when nothing was streamed.
 */
export function withEmittedTokens(
  stats: CompletionStats | undefined,
  emittedPieces: number
): CompletionStats | undefined {
  const emittedTokens = emittedPieces
  if (!stats && emittedTokens === 0) return undefined
  return {
    ...(stats ?? {}),
    emittedTokens
  }
}
