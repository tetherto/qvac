'use strict'

// RSS is sampled from the Bare runtime rather than getrusage(2) maxRSS, whose
// units differ by OS (linux reports kilobytes, darwin bytes) and would make
// cross-platform memory figures incomparable. Mirrors tts-ggml's helper of the
// same name so the two addons' benchmark reports stay comparable.

const BYTES_PER_MB = 1024 * 1024
const DEFAULT_SAMPLE_INTERVAL_MS = 250
// Delay after unload before sampling reclaimed RSS, giving the allocator a
// chance to return freed pages to the OS. ACE-Step holds multi-GB of weights,
// so it needs longer to settle than a speech model.
const RECLAIM_SETTLE_MS = 1000

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function readRssFromBareOs() {
  try {
    const usage = require('bare-os').memoryUsage()
    return usage && isPositiveNumber(usage.rss) ? usage.rss : 0
  } catch {
    return 0
  }
}

function resolveProcess() {
  if (globalThis.process && typeof globalThis.process.memoryUsage === 'function') {
    return globalThis.process
  }
  try {
    const proc = require('bare-process')
    return typeof proc.memoryUsage === 'function' ? proc : null
  } catch {
    return null
  }
}

function readRssFromProcess() {
  try {
    const proc = resolveProcess()
    const usage = proc && proc.memoryUsage()
    return usage && isPositiveNumber(usage.rss) ? usage.rss : 0
  } catch {
    return 0
  }
}

function readRssBytes() {
  return readRssFromBareOs() || readRssFromProcess()
}

function filterPositive(samples) {
  return (Array.isArray(samples) ? samples : []).filter(isPositiveNumber)
}

function sumValues(values) {
  return values.reduce((total, value) => total + value, 0)
}

function maxValue(values) {
  return values.reduce((current, value) => (value > current ? value : current), values[0])
}

function minValue(values) {
  return values.reduce((current, value) => (value < current ? value : current), values[0])
}

function summarizeSamples(samples) {
  const values = filterPositive(samples)
  if (values.length === 0) {
    return { count: 0, avgBytes: 0, peakBytes: 0, minBytes: 0 }
  }
  return {
    count: values.length,
    avgBytes: sumValues(values) / values.length,
    peakBytes: maxValue(values),
    minBytes: minValue(values)
  }
}

function maxWithFloor(values, floor) {
  const list = Array.isArray(values) ? values : []
  return list.reduce((current, value) => (value > current ? value : current), floor || 0)
}

// Weighting by sample count recovers the true overall mean; a mean-of-means
// would skew toward runs that collected fewer samples.
function weightedMeanBytes(runs) {
  const weighted = (Array.isArray(runs) ? runs : []).filter(
    (run) => run && isPositiveNumber(run.avgRssBytes) && isPositiveNumber(run.rssSampleCount)
  )
  if (weighted.length === 0) return 0
  const totalCount = weighted.reduce((sum, run) => sum + run.rssSampleCount, 0)
  const weightedSum = weighted.reduce((sum, run) => sum + run.avgRssBytes * run.rssSampleCount, 0)
  return totalCount > 0 ? weightedSum / totalCount : 0
}

function collectSample(state) {
  const rss = readRssBytes()
  if (rss > 0) state.samples.push(rss)
  return rss
}

function scheduleSample(state) {
  state.timer = setTimeout(() => {
    if (!state.running) return
    collectSample(state)
    scheduleSample(state)
  }, state.intervalMs)
  if (state.timer && typeof state.timer.unref === 'function') {
    state.timer.unref()
  }
}

function startSampler(state) {
  if (state.running) return
  state.running = true
  collectSample(state)
  scheduleSample(state)
}

function stopSampler(state) {
  state.running = false
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  collectSample(state)
  return summarizeSamples(state.samples)
}

function createMemorySampler(options) {
  const state = {
    intervalMs: (options && options.intervalMs) || DEFAULT_SAMPLE_INTERVAL_MS,
    samples: [],
    timer: null,
    running: false
  }
  return {
    start: () => startSampler(state),
    stop: () => stopSampler(state),
    sampleOnce: () => collectSample(state),
    get samples() {
      return state.samples
    }
  }
}

function toBytes(value) {
  return isPositiveNumber(value) ? value : 0
}

// A failed unload leaves the model resident, so there is no reclaim to measure
// and no post-unload sample worth taking. The caller learns the engine is still
// alive and can retry the cleanup.
async function measureUnload(unload, sampleRss) {
  try {
    await unload()
  } catch (error) {
    return { unloaded: false, rssAfterUnloadBytes: null, error }
  }
  return { unloaded: true, rssAfterUnloadBytes: await sampleRss(), error: null }
}

// Without a post-unload sample there is nothing to subtract from, and treating
// the missing value as zero would report the whole footprint as reclaimed.
function computeReclaim(input) {
  const afterUnload = input && input.rssAfterUnloadBytes
  if (!isPositiveNumber(afterUnload)) {
    return { reclaimedBytes: null, reclaimedFromPeakBytes: null }
  }
  const afterLoad = toBytes(input && input.rssAfterLoadBytes)
  const peak = toBytes(input && input.peakRssBytes)
  const baseline = peak > 0 ? peak : afterLoad
  return {
    reclaimedBytes: afterLoad - afterUnload,
    reclaimedFromPeakBytes: baseline - afterUnload
  }
}

function roundTo(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function bytesToMb(bytes, digits) {
  if (!isPositiveNumber(bytes)) return 0
  const mb = bytes / BYTES_PER_MB
  return typeof digits === 'number' ? roundTo(mb, digits) : mb
}

// Null means "not measured", which is different from zero and must survive into
// the report rather than becoming a made-up number.
function bytesToMbOrNull(bytes) {
  return bytes === null || bytes === undefined ? null : bytesToMb(bytes, 2)
}

function buildMemorySummary(input) {
  const source = input || {}
  const rssAfterLoadBytes = toBytes(source.rssAfterLoadBytes)
  const peakRssBytes = Math.max(toBytes(source.peakRssBytes), rssAfterLoadBytes)
  const rssAfterUnloadBytes = isPositiveNumber(source.rssAfterUnloadBytes)
    ? source.rssAfterUnloadBytes
    : null
  const reclaim = computeReclaim({ rssAfterLoadBytes, peakRssBytes, rssAfterUnloadBytes })
  return {
    avgRssMb: bytesToMb(source.avgRssBytes, 2),
    peakRssMb: bytesToMb(peakRssBytes, 2),
    rssBeforeLoadMb: bytesToMb(source.rssBeforeLoadBytes, 2),
    rssAfterLoadMb: bytesToMb(rssAfterLoadBytes, 2),
    rssAfterUnloadMb: bytesToMbOrNull(rssAfterUnloadBytes),
    reclaimedMb: bytesToMbOrNull(reclaim.reclaimedBytes),
    reclaimedFromPeakMb: bytesToMbOrNull(reclaim.reclaimedFromPeakBytes),
    sampleCount: isPositiveNumber(source.sampleCount) ? source.sampleCount : 0
  }
}

function summarizeRunMemory(runs, context) {
  const list = Array.isArray(runs) ? runs : []
  const ctx = context || {}
  const rssAfterLoadBytes = toBytes(ctx.rssAfterLoadBytes)
  const avgRssBytes = weightedMeanBytes(list) || rssAfterLoadBytes
  const peakRssBytes = maxWithFloor(
    list.map((run) => (run && run.peakRssBytes) || 0),
    rssAfterLoadBytes
  )
  const sampleCount = list.reduce((sum, run) => sum + ((run && run.rssSampleCount) || 0), 0)
  return buildMemorySummary({
    rssBeforeLoadBytes: ctx.rssBeforeLoadBytes,
    rssAfterLoadBytes,
    avgRssBytes,
    peakRssBytes,
    rssAfterUnloadBytes: ctx.rssAfterUnloadBytes,
    sampleCount
  })
}

module.exports = {
  BYTES_PER_MB,
  DEFAULT_SAMPLE_INTERVAL_MS,
  RECLAIM_SETTLE_MS,
  readRssBytes,
  createMemorySampler,
  summarizeSamples,
  maxWithFloor,
  measureUnload,
  computeReclaim,
  roundTo,
  bytesToMb,
  buildMemorySummary,
  summarizeRunMemory
}
