'use strict'

const test = require('brittle')
const { runRtfBenchmark } = require('./rtf-benchmark.shared.js')

test('RTF benchmark: collect real-time factor on CI device', { timeout: 600000 }, async (t) => {
  const result = await runRtfBenchmark()

  if (result.skipped) {
    t.pass(result.reason)
    return
  }

  t.is(
    result.report.runs.length,
    result.report.config.benchmarkRuns,
    `Completed ${result.report.config.benchmarkRuns} benchmark runs`
  )
  t.ok(result.report.summary.rtf.mean > 0, 'Mean RTF should be positive')
})
