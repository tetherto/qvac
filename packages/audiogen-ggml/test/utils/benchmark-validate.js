'use strict'

class BenchmarkResultError extends Error {
  constructor(failures) {
    super(`benchmark result is not usable: ${failures.join('; ')}`)
    this.name = 'BenchmarkResultError'
    this.failures = failures
  }
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0
}

function checkRunCount(settings, runs) {
  const expected = settings.numRuns
  const actual = runs.length
  return {
    ok: actual === expected,
    message: `completed ${expected} measured run(s), got ${actual}`
  }
}

function checkMeanRtf(summary) {
  const mean = summary.rtf && summary.rtf.mean
  return {
    ok: isPositiveFinite(mean),
    message: `mean RTF is positive and finite, got ${mean}`
  }
}

function checkRenderedAudio(runs) {
  const silent = runs.filter((run) => !isPositiveFinite(run.sampleCount)).length
  return {
    ok: silent === 0,
    message: `every run rendered audio, ${silent} run(s) rendered none`
  }
}

function checkPeakMemory(summary) {
  const peak = summary.memory && summary.memory.peakRssMb
  return {
    ok: isPositiveFinite(peak),
    message: `peak RSS is positive, got ${peak}`
  }
}

function checkMemoryOrdering(summary) {
  const memory = summary.memory || {}
  return {
    ok: memory.peakRssMb >= memory.avgRssMb,
    message: `peak RSS ${memory.peakRssMb} is at least average RSS ${memory.avgRssMb}`
  }
}

function checkUpperBound(settings, summary) {
  const bound = settings.rtfUpperBound
  if (bound === null || bound === undefined) return null
  const mean = summary.rtf && summary.rtf.mean
  return {
    ok: isPositiveFinite(mean) && mean <= bound,
    message: `mean RTF ${mean} is within the ${bound} upper bound`
  }
}

// Ordered so the most fundamental failure is reported first.
function evaluateBenchmarkResult({ settings, summary, runs }) {
  return [
    checkRunCount(settings, runs),
    checkMeanRtf(summary),
    checkRenderedAudio(runs),
    checkPeakMemory(summary),
    checkMemoryOrdering(summary),
    checkUpperBound(settings, summary)
  ].filter(Boolean)
}

function failedChecks(checks) {
  return checks.filter((check) => !check.ok).map((check) => check.message)
}

// Both harnesses call this before emitting anything, so an unusable measurement
// never reaches an artifact, a log record or a green mobile test.
function assertBenchmarkResult(input) {
  const failures = failedChecks(evaluateBenchmarkResult(input))
  if (failures.length > 0) throw new BenchmarkResultError(failures)
}

module.exports = {
  BenchmarkResultError,
  evaluateBenchmarkResult,
  failedChecks,
  assertBenchmarkResult
}
