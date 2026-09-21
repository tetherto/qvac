'use strict'

// Pure descriptive statistics for the RTF benchmark. Kept out of the brittle
// suite (which loads the native addon) so it stays unit-testable on its own.

// A run whose stddev exceeds this fraction of its mean is flagged noisy in the
// report, telling the reader not to compare it against another device.
const NOISY_STDDEV_RATIO = 0.15

const EMPTY_STATS = { mean: 0, min: 0, max: 0, stddev: 0, p50: 0, p95: 0, count: 0 }

function sortAscending(values) {
  return [...values].sort((a, b) => a - b)
}

function meanOf(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stddevOf(values, mean) {
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// Linear interpolation between the two neighbouring ranks, matching the
// convention the sibling addons' aggregators expect.
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = (p / 100) * (sorted.length - 1)
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

function computeStats(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value))
  if (list.length === 0) return { ...EMPTY_STATS }
  const sorted = sortAscending(list)
  const mean = meanOf(sorted)
  return {
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stddev: stddevOf(sorted, mean),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    count: sorted.length
  }
}

function stddevOverMean(stats) {
  if (!stats || !(stats.mean > 0)) return 0
  return stats.stddev / stats.mean
}

function isNoisy(stats) {
  return stddevOverMean(stats) > NOISY_STDDEV_RATIO
}

// The engine reports RTF directly; fall back to wall time over rendered audio
// duration when a run did not surface it (older prebuilds, GPU fallback paths).
function resolveRealTimeFactor({ statsRtf, wallMs, audioDurationMs }) {
  if (Number.isFinite(statsRtf) && statsRtf > 0) return statsRtf
  if (!(audioDurationMs > 0) || !Number.isFinite(wallMs)) return 0
  return wallMs / audioDurationMs
}

module.exports = {
  NOISY_STDDEV_RATIO,
  percentile,
  computeStats,
  stddevOverMean,
  isNoisy,
  resolveRealTimeFactor
}
