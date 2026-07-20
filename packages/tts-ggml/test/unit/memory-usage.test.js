'use strict'

const test = require('brittle')
const {
  BYTES_PER_MB,
  readRssBytes,
  createMemorySampler,
  summarizeSamples,
  maxWithFloor,
  computeReclaim,
  bytesToMb,
  buildMemorySummary,
  summarizeRunMemory
} = require('../utils/memory-usage.js')

test('summarizeSamples returns zeros for empty input', (t) => {
  t.alike(summarizeSamples([]), { count: 0, avgBytes: 0, peakBytes: 0, minBytes: 0 })
  t.alike(summarizeSamples(undefined), { count: 0, avgBytes: 0, peakBytes: 0, minBytes: 0 })
})

test('summarizeSamples ignores non-positive samples and aggregates the rest', (t) => {
  const summary = summarizeSamples([10, 30, 0, -5, 20, null])
  t.is(summary.count, 3)
  t.is(summary.avgBytes, 20)
  t.is(summary.peakBytes, 30)
  t.is(summary.minBytes, 10)
})

test('maxWithFloor returns the peak while respecting the provided floor', (t) => {
  t.is(maxWithFloor([10, 40, 25]), 40)
  t.is(maxWithFloor([10, 40, 25], 100), 100)
  t.is(maxWithFloor([], 64), 64)
})

test('bytesToMb converts and rounds using the shared constant', (t) => {
  t.is(bytesToMb(BYTES_PER_MB), 1)
  t.is(bytesToMb(BYTES_PER_MB * 3, 2), 3)
  t.is(bytesToMb(1.5 * BYTES_PER_MB, 1), 1.5)
  t.is(bytesToMb(0), 0)
  t.is(bytesToMb(-100), 0)
})

test('computeReclaim measures memory returned after unload', (t) => {
  const reclaim = computeReclaim({
    rssAfterLoadBytes: 200,
    peakRssBytes: 260,
    rssAfterUnloadBytes: 150
  })
  t.is(reclaim.reclaimedBytes, 50)
  t.is(reclaim.reclaimedFromPeakBytes, 110)
})

test('computeReclaim falls back to after-load baseline when peak is missing', (t) => {
  const reclaim = computeReclaim({ rssAfterLoadBytes: 100, rssAfterUnloadBytes: 40 })
  t.is(reclaim.reclaimedBytes, 60)
  t.is(reclaim.reclaimedFromPeakBytes, 60)
})

test('buildMemorySummary converts raw bytes into a rounded MB report', (t) => {
  const summary = buildMemorySummary({
    rssBeforeLoadBytes: 50 * BYTES_PER_MB,
    rssAfterLoadBytes: 200 * BYTES_PER_MB,
    avgRssBytes: 220 * BYTES_PER_MB,
    peakRssBytes: 260 * BYTES_PER_MB,
    rssAfterUnloadBytes: 120 * BYTES_PER_MB,
    sampleCount: 42
  })
  t.is(summary.rssBeforeLoadMb, 50)
  t.is(summary.rssAfterLoadMb, 200)
  t.is(summary.avgRssMb, 220)
  t.is(summary.peakRssMb, 260)
  t.is(summary.rssAfterUnloadMb, 120)
  t.is(summary.reclaimedMb, 80)
  t.is(summary.reclaimedFromPeakMb, 140)
  t.is(summary.sampleCount, 42)
})

test('buildMemorySummary clamps peak to at least the post-load footprint', (t) => {
  const summary = buildMemorySummary({
    rssAfterLoadBytes: 200 * BYTES_PER_MB,
    peakRssBytes: 10 * BYTES_PER_MB,
    rssAfterUnloadBytes: 190 * BYTES_PER_MB
  })
  t.is(summary.peakRssMb, 200)
  t.is(summary.reclaimedMb, 10)
})

test('buildMemorySummary reports zero when unload does not free memory', (t) => {
  const summary = buildMemorySummary({
    rssAfterLoadBytes: 100 * BYTES_PER_MB,
    peakRssBytes: 100 * BYTES_PER_MB,
    rssAfterUnloadBytes: 130 * BYTES_PER_MB
  })
  t.is(summary.reclaimedMb, 0)
})

test('reclaimedMb uses the after-load baseline, not peak, so desktop and mobile agree', (t) => {
  const summary = buildMemorySummary({
    rssAfterLoadBytes: 200 * BYTES_PER_MB,
    peakRssBytes: 500 * BYTES_PER_MB,
    rssAfterUnloadBytes: 150 * BYTES_PER_MB
  })
  t.is(summary.reclaimedMb, 50, 'reclaimed is afterLoad - afterUnload (200 - 150)')
  t.is(summary.reclaimedFromPeakMb, 350, 'peak-based reclaim stays a distinct field (500 - 150)')
})

test('summarizeRunMemory weights the average by each run sample count', (t) => {
  const summary = summarizeRunMemory(
    [
      { avgRssBytes: 100 * BYTES_PER_MB, peakRssBytes: 120 * BYTES_PER_MB, rssSampleCount: 1 },
      { avgRssBytes: 200 * BYTES_PER_MB, peakRssBytes: 260 * BYTES_PER_MB, rssSampleCount: 3 }
    ],
    { rssAfterLoadBytes: 50 * BYTES_PER_MB, rssAfterUnloadBytes: 40 * BYTES_PER_MB }
  )
  t.is(summary.avgRssMb, 175, 'weighted mean (100*1 + 200*3)/4, not the 150 mean-of-means')
  t.is(summary.peakRssMb, 260)
  t.is(summary.sampleCount, 4)
  t.is(summary.reclaimedMb, 10)
})

test('summarizeRunMemory falls back to the post-load footprint when no samples exist', (t) => {
  const summary = summarizeRunMemory([], {
    rssAfterLoadBytes: 200 * BYTES_PER_MB,
    rssAfterUnloadBytes: 120 * BYTES_PER_MB
  })
  t.is(summary.avgRssMb, 200)
  t.is(summary.peakRssMb, 200)
  t.is(summary.reclaimedMb, 80)
  t.is(summary.sampleCount, 0)
})

test('summarizeRunMemory floors the peak at the post-load footprint', (t) => {
  const summary = summarizeRunMemory(
    [{ avgRssBytes: 150 * BYTES_PER_MB, peakRssBytes: 150 * BYTES_PER_MB, rssSampleCount: 4 }],
    { rssAfterLoadBytes: 200 * BYTES_PER_MB, rssAfterUnloadBytes: 190 * BYTES_PER_MB }
  )
  t.is(summary.avgRssMb, 150)
  t.is(summary.peakRssMb, 200, 'peak below the loaded footprint is clamped up to it')
  t.is(summary.reclaimedMb, 10)
})

test('summarizeRunMemory ignores runs that collected no samples', (t) => {
  const summary = summarizeRunMemory(
    [
      { avgRssBytes: 100 * BYTES_PER_MB, peakRssBytes: 120 * BYTES_PER_MB, rssSampleCount: 2 },
      { avgRssBytes: 0, peakRssBytes: 0, rssSampleCount: 0 },
      { avgRssBytes: 300 * BYTES_PER_MB, peakRssBytes: 320 * BYTES_PER_MB, rssSampleCount: 2 }
    ],
    { rssAfterLoadBytes: 50 * BYTES_PER_MB, rssAfterUnloadBytes: 30 * BYTES_PER_MB }
  )
  t.is(summary.avgRssMb, 200, 'weighted mean of the two sampled runs (100*2 + 300*2)/4')
  t.is(summary.peakRssMb, 320)
  t.is(summary.sampleCount, 4)
  t.is(summary.reclaimedMb, 20)
})

test('readRssBytes reports a positive resident set size on the bare runtime', (t) => {
  const rss = readRssBytes()
  t.ok(rss > 0, 'RSS should be a positive byte count')
})

test('createMemorySampler collects live samples between start and stop', async (t) => {
  const sampler = createMemorySampler({ intervalMs: 5 })
  sampler.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const summary = sampler.stop()
  t.ok(summary.count >= 1, 'sampler should collect at least one sample')
  t.ok(summary.peakBytes >= summary.avgBytes, 'peak should be >= average')
  t.ok(summary.avgBytes >= summary.minBytes, 'average should be >= minimum')
})
