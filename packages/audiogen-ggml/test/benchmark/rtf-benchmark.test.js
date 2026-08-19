'use strict'

// Desktop harness for the ACE-Step RTF benchmark. The measurement is shared with
// the on-device lane; see benchmarks/RTF-BENCHMARKS.md.

const test = require('brittle')
const {
  readBenchmarkSettings,
  runRtfBenchmark,
  writeRtfArtifact,
  emitCanonicalReport,
  evaluateBenchmarkResult
} = require('../utils/benchmark-runner')

// A hung generation must not hold the whole matrix; a single ACE-Step render is
// minutes at worst, so this is a ceiling rather than a target.
const SUITE_TIMEOUT_MS = 3600000

// runRtfBenchmark has already thrown on any failure. Re-reporting the same
// checks gives each one a line in the brittle output.
function reportResultChecks(t, settings, summary, runs) {
  for (const check of evaluateBenchmarkResult({ settings, summary, runs })) {
    t.ok(check.ok, check.message)
  }
}

test('RTF benchmark: ACE-Step music generation', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
  const settings = readBenchmarkSettings()
  const result = await runRtfBenchmark(settings)
  t.teardown(() => result.destroy())

  writeRtfArtifact(settings, result.report)
  emitCanonicalReport(settings, result.summary, result.backend)
  reportResultChecks(t, settings, result.summary, result.runs)
})
