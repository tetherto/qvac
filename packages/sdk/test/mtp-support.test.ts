import test from 'brittle'
import {
  batchCompletionStreamResponseSchema,
  completionStreamResponseSchema
} from '@qvac/inference/surface'
import { buildFinalFromEvents } from '@/utils/aggregate-events'
import type { CompletionStats } from '@qvac/sdk'

test('SDK response parsing and final aggregation preserve optional MTP counters', (t) => {
  for (const stats of [
    { generatedTokens: 10, draftAccepted: 6, draftTotal: 9 },
    { generatedTokens: 10, draftAccepted: 0, draftTotal: 0 },
    { generatedTokens: 10 }
  ]) {
    const response = completionStreamResponseSchema.parse({
      type: 'completionStream',
      done: true,
      events: [
        { type: 'completionStats', seq: 0, stats },
        { type: 'completionDone', seq: 1, stopReason: 'eos' }
      ]
    })
    const { final, error } = buildFinalFromEvents(response.events, new Map())
    t.is(error, undefined)
    t.alike(final.stats, stats)
  }
})

test('SDK batch response parsing preserves inactive MTP counters', (t) => {
  const stats: CompletionStats = { draftAccepted: 0, draftTotal: 0 }
  const response = batchCompletionStreamResponseSchema.parse({
    type: 'batchCompletionStream',
    done: true,
    events: [],
    stats
  })
  t.alike(response.stats, stats)
})
