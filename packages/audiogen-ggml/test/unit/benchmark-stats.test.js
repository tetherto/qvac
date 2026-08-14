'use strict'

// Pure, offline checks for the RTF benchmark's descriptive statistics. No native
// addon, no models, no network.

const test = require('brittle')
const {
  NOISY_STDDEV_RATIO,
  percentile,
  computeStats,
  stddevOverMean,
  isNoisy,
  resolveRealTimeFactor
} = require('../utils/benchmark-stats')

test('computeStats: empty and non-numeric input yields a zeroed summary', (t) => {
  const empty = computeStats([])
  t.is(empty.count, 0)
  t.is(empty.mean, 0)
  t.is(empty.p95, 0)

  t.alike(computeStats(undefined), empty, 'undefined behaves like an empty list')
  t.alike(computeStats([Number.NaN, Number.POSITIVE_INFINITY]), empty, 'non-finite values drop out')
})

test('computeStats: summarises a known sample', (t) => {
  const stats = computeStats([4, 1, 3, 2])

  t.is(stats.count, 4)
  t.is(stats.mean, 2.5)
  t.is(stats.min, 1)
  t.is(stats.max, 4)
  t.is(stats.p50, 2.5, 'p50 interpolates between the two middle ranks')
  t.ok(Math.abs(stats.stddev - Math.sqrt(1.25)) < 1e-12, 'population stddev')
})

test('computeStats: a single sample has no spread', (t) => {
  const stats = computeStats([1.5])

  t.is(stats.count, 1)
  t.is(stats.mean, 1.5)
  t.is(stats.p50, 1.5)
  t.is(stats.p95, 1.5)
  t.is(stats.stddev, 0)
})

test('percentile: interpolates between neighbouring ranks', (t) => {
  t.is(percentile([], 50), 0, 'empty input is zero')
  t.is(percentile([10, 20, 30], 0), 10)
  t.is(percentile([10, 20, 30], 100), 30)
  t.is(percentile([10, 20, 30], 50), 20, 'exact rank needs no interpolation')
  t.is(percentile([10, 20], 50), 15, 'midpoint between two ranks')
})

test('isNoisy: flags a run only once spread exceeds the ratio', (t) => {
  const steady = { mean: 1, stddev: NOISY_STDDEV_RATIO / 2 }
  const jittery = { mean: 1, stddev: NOISY_STDDEV_RATIO * 2 }

  t.absent(isNoisy(steady), 'tight spread is not noisy')
  t.ok(isNoisy(jittery), 'wide spread is noisy')
  t.absent(isNoisy({ mean: 1, stddev: NOISY_STDDEV_RATIO }), 'exactly at the ratio is not noisy')
})

test('stddevOverMean: guards against a zero or missing mean', (t) => {
  t.is(stddevOverMean(null), 0)
  t.is(stddevOverMean({ mean: 0, stddev: 5 }), 0, 'no division by zero')
  t.is(stddevOverMean({ mean: 2, stddev: 1 }), 0.5)
})

test('resolveRealTimeFactor: prefers the engine-reported value', (t) => {
  t.is(
    resolveRealTimeFactor({ statsRtf: 0.5, wallMs: 9000, audioDurationMs: 3000 }),
    0.5,
    'engine RTF wins over the wall-clock estimate'
  )
})

test('resolveRealTimeFactor: falls back to wall time over audio duration', (t) => {
  t.is(resolveRealTimeFactor({ statsRtf: undefined, wallMs: 6000, audioDurationMs: 3000 }), 2)
  t.is(resolveRealTimeFactor({ statsRtf: 0, wallMs: 1500, audioDurationMs: 3000 }), 0.5)
})

test('resolveRealTimeFactor: yields zero when neither source is usable', (t) => {
  t.is(resolveRealTimeFactor({ statsRtf: 0, wallMs: 6000, audioDurationMs: 0 }), 0)
  t.is(resolveRealTimeFactor({ statsRtf: undefined, wallMs: Number.NaN, audioDurationMs: 3000 }), 0)
})
