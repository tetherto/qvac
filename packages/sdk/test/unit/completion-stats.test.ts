import test from 'brittle'
import { completionStatsSchema } from '@/schemas'
import {
  normalizeCompletionStats,
  withEmittedGeneratedTokens
} from '@/server/bare/plugins/llamacpp-completion/ops/completion-stats'
import type { LlmStats } from '@/server/bare/types/addon-responses'

test('normalizeCompletionStats: drops non-finite addon numbers', (t) => {
  const stats: LlmStats = {
    TTFT: Number.NaN,
    TPS: Number.POSITIVE_INFINITY,
    CacheTokens: 12,
    promptTokens: Number.NEGATIVE_INFINITY,
    generatedTokens: 40,
    backendDevice: 'gpu'
  }

  const normalized = normalizeCompletionStats(stats)

  t.alike(normalized, {
    cacheTokens: 12,
    generatedTokens: 40,
    backendDevice: 'gpu'
  })
  t.is(completionStatsSchema.safeParse(normalized).success, true)
})

test('normalizeCompletionStats: returns undefined when no finite stats remain', (t) => {
  const normalized = normalizeCompletionStats({
    TTFT: Number.NaN,
    TPS: Number.POSITIVE_INFINITY
  })

  t.is(normalized, undefined)
})

test('withEmittedGeneratedTokens: overrides inflated n_eval with streamed piece count', (t) => {
  const normalized = normalizeCompletionStats({
    TTFT: 12,
    generatedTokens: 512,
    backendDevice: 'gpu'
  })

  const adjusted = withEmittedGeneratedTokens(normalized, 113)

  t.alike(adjusted, {
    timeToFirstToken: 12,
    generatedTokens: 113,
    backendDevice: 'gpu'
  })
  t.is(completionStatsSchema.safeParse(adjusted).success, true)
})

test('withEmittedGeneratedTokens: leaves stats alone when nothing was emitted', (t) => {
  const normalized = normalizeCompletionStats({ generatedTokens: 0 })
  t.alike(withEmittedGeneratedTokens(normalized, 0), { generatedTokens: 0 })
  t.is(withEmittedGeneratedTokens(undefined, 0), undefined)
})

test('withEmittedGeneratedTokens: synthesizes stats when only the stream count exists', (t) => {
  t.alike(withEmittedGeneratedTokens(undefined, 4), { generatedTokens: 4 })
})
