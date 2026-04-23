'use strict'

require('./integration-runtime.cjs')

const process = require('bare-process')
const {
  DEFAULT_MOBILE_BENCHMARK_MATRIX,
  parseBenchmarkMatrixConfig,
  runRtfBenchmarkMatrix
} = require('../benchmark/rtf-benchmark.shared.js')

function getMobileBenchmarkMatrix () {
  return parseBenchmarkMatrixConfig(
    process.env.QVAC_PARAKEET_BENCHMARK_MATRIX_JSON,
    DEFAULT_MOBILE_BENCHMARK_MATRIX
  )
}

async function runMobileRtfBenchmarks (options = {}) { // eslint-disable-line no-unused-vars
  const matrix = getMobileBenchmarkMatrix()

  console.log('')
  console.log('='.repeat(70))
  console.log(`Running ${matrix.length} mobile RTF benchmark configuration(s)`)
  console.log('='.repeat(70))

  const results = await runRtfBenchmarkMatrix(matrix, {
    emitInlineReport: true,
    runnerLabel: process.env.QVAC_PARAKEET_BENCHMARK_RUNNER || 'mobile-test-app'
  })

  const completed = results.filter(result => !result.skipped).length
  console.log(`Completed ${completed} mobile RTF benchmark configuration(s).`)
  return results
}
