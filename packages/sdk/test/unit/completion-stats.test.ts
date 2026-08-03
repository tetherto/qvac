import test from 'brittle'
import { completionStatsSchema } from '@/schemas'
import {
  normalizeCompletionStats,
  withEmittedTokens
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

test('withEmittedTokens: attaches streamed piece count without overwriting decode count', (t) => {
  const normalized = normalizeCompletionStats({
    TTFT: 12,
    generatedTokens: 512,
    backendDevice: 'gpu'
  })

  const adjusted = withEmittedTokens(normalized, 113)

  t.alike(adjusted, {
    timeToFirstToken: 12,
    generatedTokens: 512,
    emittedTokens: 113,
    backendDevice: 'gpu'
  })
  t.is(completionStatsSchema.safeParse(adjusted).success, true)
})

test('withEmittedTokens: records zero emission so inflated n_eval is not used for usage', (t) => {
  const normalized = normalizeCompletionStats({ generatedTokens: 512 })
  t.alike(withEmittedTokens(normalized, 0), { generatedTokens: 512, emittedTokens: 0 })
  t.is(withEmittedTokens(undefined, 0), undefined)
})

test('withEmittedTokens: synthesizes stats when only the stream count exists', (t) => {
  t.alike(withEmittedTokens(undefined, 4), { emittedTokens: 4 })
})
