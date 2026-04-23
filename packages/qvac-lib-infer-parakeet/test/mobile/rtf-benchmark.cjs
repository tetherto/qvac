'use strict'

require('./integration-runtime.cjs')

const process = require('bare-process')
const sharedModuleCandidates = [
  '../benchmark/rtf-benchmark.shared.js',
  './test/benchmark/rtf-benchmark.shared.js'
]

let benchmarkShared = null
let lastSharedModuleError = null

for (const candidate of sharedModuleCandidates) {
  try {
    benchmarkShared = require(candidate)
    break
  } catch (error) {
    lastSharedModuleError = error
  }
}

if (!benchmarkShared) {
  throw lastSharedModuleError || new Error('Unable to load rtf-benchmark.shared.js')
}

const {
  DEFAULT_MOBILE_BENCHMARK_MATRIX,
  parseBenchmarkMatrixConfig,
  runRtfBenchmarkMatrix
} = benchmarkShared

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
