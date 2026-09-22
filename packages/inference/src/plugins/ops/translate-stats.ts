import type { TranslationStats } from '@/schemas/index'
import type { NmtStats } from '@/utils/addon-responses'

export const NMT_SECONDS_TO_MS = 1000

// The nmtcpp addon's counters accumulate over the life of a loaded model, so a
// response carries the model's totals rather than the request's. Differencing
// against what the previous job left behind is exact rather than approximate:
// the addon serializes jobs per model, so no second request can land inside the
// window. A `runBatch` between two `run` calls is the one gap — it advances the
// counters and reports no stats, so its work lands in the next delta.
const NMT_CUMULATIVE_KEYS = ['totalTime', 'totalTokens', 'decodeTime', 'encodeTime'] as const

type NmtCumulativeKey = (typeof NMT_CUMULATIVE_KEYS)[number]
type NmtCounters = Partial<Record<NmtCumulativeKey, number>>

// Keyed on the loaded model instance, so an unload/reload starts from zero the
// way the addon's own counters do.
const lastCounters = new WeakMap<object, NmtCounters>()

function takeDeltas(stats: Partial<NmtStats>, model: object): NmtCounters {
  const previous = lastCounters.get(model) ?? {}
  const current: NmtCounters = { ...previous }
  const deltas: NmtCounters = {}

  for (const key of NMT_CUMULATIVE_KEYS) {
    const value = stats[key]
    if (typeof value !== 'number') continue
    current[key] = value
    const delta = value - (previous[key] ?? 0)
    // A counter that went backwards was reset under us; the reading is then the
    // request's own figure.
    deltas[key] = delta < 0 ? value : delta
  }

  lastCounters.set(model, current)
  return deltas
}

export function buildNmtTranslationStats(
  stats: Partial<NmtStats> | undefined,
  model: object
): TranslationStats {
  if (!stats) return {}

  const { totalTime, totalTokens, decodeTime, encodeTime } = takeDeltas(stats, model)
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
