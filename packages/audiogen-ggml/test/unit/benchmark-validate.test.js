'use strict'

const test = require('brittle')
const {
  BenchmarkResultError,
  evaluateBenchmarkResult,
  failedChecks,
  assertBenchmarkResult
} = require('../utils/benchmark-validate')

function validInput(overrides = {}) {
  return {
    settings: { numRuns: 2, rtfUpperBound: null, ...(overrides.settings || {}) },
    summary: {
      rtf: { mean: 0.8 },
      memory: { avgRssMb: 900, peakRssMb: 1200 },
      ...(overrides.summary || {})
    },
    runs: overrides.runs || [{ sampleCount: 480000 }, { sampleCount: 480000 }]
  }
}

test('a healthy result passes every check', (t) => {
  const checks = evaluateBenchmarkResult(validInput())
  t.is(failedChecks(checks).length, 0, 'no failures')
  t.execution(() => assertBenchmarkResult(validInput()), 'does not throw')
})

test('a short run count fails', (t) => {
  const input = validInput({ runs: [{ sampleCount: 480000 }] })
  t.is(failedChecks(evaluateBenchmarkResult(input)).length, 1, 'one failure')
  t.exception(() => assertBenchmarkResult(input), /completed 2 measured run\(s\), got 1/)
})

test('a non-positive or non-finite mean RTF fails', (t) => {
  for (const mean of [0, -1, NaN, null, undefined]) {
    const input = validInput({ summary: { rtf: { mean } } })
    t.exception(
      () => assertBenchmarkResult(input),
      /mean RTF is positive and finite/,
      `mean=${mean}`
    )
  }
})

test('a run that rendered no audio fails', (t) => {
  const input = validInput({ runs: [{ sampleCount: 480000 }, { sampleCount: 0 }] })
  t.exception(() => assertBenchmarkResult(input), /1 run\(s\) rendered none/)
})

test('non-positive peak RSS fails', (t) => {
  const input = validInput({
    summary: { rtf: { mean: 0.8 }, memory: { avgRssMb: 0, peakRssMb: 0 } }
  })
  t.exception(() => assertBenchmarkResult(input), /peak RSS is positive/)
})

test('peak RSS below average RSS fails', (t) => {
  const input = validInput({
    summary: { rtf: { mean: 0.8 }, memory: { avgRssMb: 1500, peakRssMb: 1200 } }
  })
  t.exception(() => assertBenchmarkResult(input), /at least average RSS/)
})

test('the upper bound is only checked when set', (t) => {
  const unset = validInput({ settings: { rtfUpperBound: null } })
  t.is(evaluateBenchmarkResult(unset).length, 5, 'bound check omitted when unset')

  const set = validInput({ settings: { rtfUpperBound: 2 } })
  t.is(evaluateBenchmarkResult(set).length, 6, 'bound check present when set')
})

test('exceeding the upper bound fails', (t) => {
  const input = validInput({
    settings: { rtfUpperBound: 0.5 },
    summary: { rtf: { mean: 3.25 }, memory: { avgRssMb: 900, peakRssMb: 1200 } }
  })
  t.exception(() => assertBenchmarkResult(input), /mean RTF 3.25 is within the 0.5 upper bound/)
})

test('meeting the upper bound exactly passes', (t) => {
  const input = validInput({
    settings: { rtfUpperBound: 0.8 },
    summary: { rtf: { mean: 0.8 }, memory: { avgRssMb: 900, peakRssMb: 1200 } }
  })
  t.execution(() => assertBenchmarkResult(input), 'boundary is inclusive')
})

test('the error collects every failure', (t) => {
  const input = validInput({
    settings: { numRuns: 3, rtfUpperBound: 0.1 },
    summary: { rtf: { mean: 5 }, memory: { avgRssMb: 900, peakRssMb: 0 } },
    runs: [{ sampleCount: 0 }]
  })
  try {
    assertBenchmarkResult(input)
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof BenchmarkResultError, 'is a BenchmarkResultError')
    t.is(err.failures.length, 5, 'reports all five failures')
  }
})
