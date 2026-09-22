import type { TranslationStats } from '@/schemas/index'
import type { NmtStats } from '@/utils/addon-responses'

export const NMT_SECONDS_TO_MS = 1000

const NMT_CUMULATIVE_KEYS = ['totalTime', 'totalTokens', 'decodeTime', 'encodeTime'] as const

type NmtCumulativeKey = (typeof NMT_CUMULATIVE_KEYS)[number]
type NmtCounters = Partial<Record<NmtCumulativeKey, number>>

// The addon's counters accumulate over a loaded model's life and its jobs are
// serialized per model, so the previous job's reading is this request's
// baseline. Keyed on the model instance: a reload gets fresh counters and a
// fresh baseline. `null` marks a baseline a batch has advanced past.
const lastCounters = new WeakMap<object, NmtCounters | null>()

// `runBatch` advances the counters without reporting stats, so the next single
// request cannot separate its own work from the batch's and reports none.
export function markNmtCountersStale(model: object): void {
  lastCounters.set(model, null)
}

function takeDeltas(stats: Partial<NmtStats>, model: object): NmtCounters | undefined {
  const previous = lastCounters.get(model)
  const current: NmtCounters = { ...previous }
  const deltas: NmtCounters = {}

  for (const key of NMT_CUMULATIVE_KEYS) {
    const value = stats[key]
    if (typeof value !== 'number') continue
    current[key] = value
    const delta = value - (previous?.[key] ?? 0)
    // A counter that went backwards was reset under us; the reading is then the
    // request's own figure.
    deltas[key] = delta < 0 ? value : delta
  }

  lastCounters.set(model, current)
  return previous === null ? undefined : deltas
}

export function buildNmtTranslationStats(
  stats: Partial<NmtStats> | undefined,
  model: object
): TranslationStats {
  if (!stats) return {}

  const { totalTime, totalTokens, decodeTime, encodeTime } = takeDeltas(stats, model) ?? {}
  // The addon's own TPS divides the lifetime totals, which reads lowest right
  // after load and climbs as the load cost amortises. Derive it from this
  // request's figures instead, and omit it when they cannot carry it.
  const tokensPerSecond =
    totalTokens !== undefined && totalTime !== undefined && totalTime > 0
      ? totalTokens / totalTime
      : undefined

  return {
    ...(totalTime !== undefined && { totalTime: totalTime * NMT_SECONDS_TO_MS }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(decodeTime !== undefined && { decodeTime: decodeTime * NMT_SECONDS_TO_MS }),
    ...(encodeTime !== undefined && { encodeTime: encodeTime * NMT_SECONDS_TO_MS }),
    ...(tokensPerSecond !== undefined && { tokensPerSecond }),
    ...(stats.TTFT !== undefined && { timeToFirstToken: stats.TTFT })
  }
}
