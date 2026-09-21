'use strict'

// Pure, offline checks for the RTF benchmark's memory folding. The sampler
// itself needs a live process, but the arithmetic that turns per-run sampler
// records into the report's memory block does not — and that arithmetic is what
// makes an ACE-Step row's peak/reclaimed figures trustworthy.

const test = require('brittle')
const {
  maxWithFloor,
  measureUnload,
  computeReclaim,
  bytesToMb,
  roundTo,
  summarizeSamples,
  buildMemorySummary,
  summarizeRunMemory
} = require('../utils/memory-usage')

const MB = 1024 * 1024

function runFixture(avgMb, peakMb, sampleCount) {
  return { avgRssBytes: avgMb * MB, peakRssBytes: peakMb * MB, rssSampleCount: sampleCount }
}

test('bytesToMb converts and rounds, and floors non-positive input at zero', (t) => {
  t.is(bytesToMb(1536 * MB, 1), 1536)
  t.is(bytesToMb(1.5 * MB, 2), 1.5)
  t.is(bytesToMb(0), 0)
  t.is(bytesToMb(-1), 0)
  t.is(bytesToMb(undefined), 0)
})

test('roundTo keeps the requested number of decimals', (t) => {
  t.is(roundTo(1.23456, 2), 1.23)
  t.is(roundTo(1.23556, 2), 1.24)
  t.is(roundTo(10, 0), 10)
})

test('summarizeSamples ignores non-positive samples', (t) => {
  const summary = summarizeSamples([100, 0, 300, -5, 200])

  t.is(summary.count, 3)
  t.is(summary.avgBytes, 200)
  t.is(summary.peakBytes, 300)
  t.is(summary.minBytes, 100)
})

test('summarizeSamples returns zeroes when nothing was sampled', (t) => {
  t.alike(summarizeSamples([]), { count: 0, avgBytes: 0, peakBytes: 0, minBytes: 0 })
  t.alike(summarizeSamples(null), { count: 0, avgBytes: 0, peakBytes: 0, minBytes: 0 })
})

test('maxWithFloor never drops below the floor', (t) => {
  t.is(maxWithFloor([10, 50, 30], 20), 50)
  t.is(maxWithFloor([10, 15], 20), 20, 'the floor wins when every sample is smaller')
  t.is(maxWithFloor([], 20), 20)
})

test('computeReclaim measures against both the post-load and the peak footprint', (t) => {
  const reclaim = computeReclaim({
    rssAfterLoadBytes: 100,
    peakRssBytes: 150,
    rssAfterUnloadBytes: 40
  })

  t.is(reclaim.reclaimedBytes, 60)
  t.is(reclaim.reclaimedFromPeakBytes, 110)
})

test('computeReclaim falls back to the post-load footprint when no peak was seen', (t) => {
  const reclaim = computeReclaim({ rssAfterLoadBytes: 100, rssAfterUnloadBytes: 40 })

  t.is(reclaim.reclaimedFromPeakBytes, 60)
})

test('measureUnload samples the footprint once the engine is gone', async (t) => {
  const unload = await measureUnload(
    async () => {},
    async () => 42
  )

  t.is(unload.unloaded, true)
  t.is(unload.rssAfterUnloadBytes, 42)
  t.is(unload.error, null)
})

test('measureUnload reports a failed unload without sampling', async (t) => {
  let sampled = false
  const unload = await measureUnload(
    async () => {
      throw new Error('destroy failed')
    },
    async () => {
      sampled = true
      return 42
    }
  )

  t.is(unload.unloaded, false, 'the engine is still alive, so cleanup can be retried')
  t.is(unload.rssAfterUnloadBytes, null)
  t.is(unload.error.message, 'destroy failed')
  t.is(sampled, false, 'no RSS reading is taken as though the model were unloaded')
})

test('computeReclaim reports nothing when the unload was never measured', (t) => {
  const reclaim = computeReclaim({ rssAfterLoadBytes: 100, peakRssBytes: 150 })

  t.is(reclaim.reclaimedBytes, null, 'a missing sample is not a full reclaim')
  t.is(reclaim.reclaimedFromPeakBytes, null)
})

test('buildMemorySummary leaves reclaim unavailable when the engine never unloaded', (t) => {
  const summary = buildMemorySummary({
    rssBeforeLoadBytes: 100 * MB,
    rssAfterLoadBytes: 3000 * MB,
    avgRssBytes: 2900 * MB,
    peakRssBytes: 3200 * MB,
    rssAfterUnloadBytes: null,
    sampleCount: 12
  })

  t.is(summary.rssAfterUnloadMb, null)
  t.is(summary.reclaimedMb, null, 'no unload means no reclaim figure, not 3000 MB')
  t.is(summary.reclaimedFromPeakMb, null)
  t.is(summary.peakRssMb, 3200, 'the rest of the block is still reported')
})

test('buildMemorySummary floors the peak at the post-load footprint', (t) => {
  const summary = buildMemorySummary({
    rssBeforeLoadBytes: 100 * MB,
    rssAfterLoadBytes: 3000 * MB,
    avgRssBytes: 2900 * MB,
    peakRssBytes: 2500 * MB,
    rssAfterUnloadBytes: 200 * MB,
    sampleCount: 12
  })

  t.is(summary.peakRssMb, 3000, 'a peak below the post-load RSS is raised to it')
  t.is(summary.rssAfterLoadMb, 3000)
  t.is(summary.reclaimedMb, 2800)
  t.is(summary.sampleCount, 12)
})

test('summarizeRunMemory weights each run average by its sample count', (t) => {
  const summary = summarizeRunMemory([runFixture(1000, 1200, 1), runFixture(2000, 2400, 3)], {
    rssBeforeLoadBytes: 100 * MB,
    rssAfterLoadBytes: 900 * MB,
    rssAfterUnloadBytes: 150 * MB
  })

  t.is(summary.avgRssMb, 1750, 'the 3-sample run outweighs the 1-sample run')
  t.is(summary.peakRssMb, 2400)
  t.is(summary.sampleCount, 4)
  t.is(summary.reclaimedMb, 750)
})

test('summarizeRunMemory falls back to the post-load footprint with no usable runs', (t) => {
  const summary = summarizeRunMemory([], {
    rssBeforeLoadBytes: 100 * MB,
    rssAfterLoadBytes: 900 * MB,
    rssAfterUnloadBytes: 150 * MB
  })

  t.is(summary.avgRssMb, 900)
  t.is(summary.peakRssMb, 900)
  t.is(summary.sampleCount, 0)
})
