import test from 'brittle'
import { completionStatsSchema } from '@/schemas'
import {
  normalizeCompletionStats,
  withEmittedTokens,
  stoppedByLength
} from '@/plugins/builtin/llamacpp-completion/ops/completion-stats'
import type { LlmStats } from '@/utils/addon-responses'

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

test('stoppedByLength: context boundary is a length stop', (t) => {
  t.is(
    stoppedByLength({
      cancelled: false,
      effectivePredict: 1024,
      generatedTokens: 984,
      stoppedAtContextBoundary: true
    }),
    true
  )
})

test('stoppedByLength: cancellation takes precedence over context exhaustion', (t) => {
  t.is(
    stoppedByLength({
      cancelled: true,
      effectivePredict: 1024,
      generatedTokens: 984,
      stoppedAtContextBoundary: true
    }),
    false
  )
})

test('stoppedByLength: positive prediction budget exhaustion remains a length stop', (t) => {
  t.is(
    stoppedByLength({
      cancelled: false,
      effectivePredict: 8,
      generatedTokens: 8,
      stoppedAtContextBoundary: false
    }),
    true
  )
})
