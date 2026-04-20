'use strict'

require('./integration-runtime.cjs')

const os = require('bare-os')
const process = require('bare-process')

/* global runIntegrationModule */

function setBenchmarkEnv (modelType, useGPU) {
  const platform = os.platform()
  let backend = 'cpu'

  if (useGPU) {
    if (platform === 'ios' || platform === 'darwin') backend = 'coreml-requested'
    else if (platform === 'android') backend = 'nnapi-requested'
    else if (platform === 'win32') backend = 'auto-gpu-requested'
    else if (platform === 'linux') backend = 'auto-gpu-requested'
    else backend = 'gpu-requested'
  }

  process.env.QVAC_PARAKEET_BENCHMARK_MODEL_TYPE = modelType
  process.env.QVAC_PARAKEET_BENCHMARK_USE_GPU = useGPU ? 'true' : 'false'
  process.env.QVAC_PARAKEET_BENCHMARK_BACKEND = backend
  process.env.QVAC_PARAKEET_BENCHMARK_DEVICE = `${platform}-${os.arch()}`
  process.env.QVAC_PARAKEET_BENCHMARK_RUNNER = `devicefarm-${platform}`
  process.env.QVAC_PARAKEET_BENCHMARK_LABEL = `${platform}-${modelType}-${useGPU ? 'gpu' : 'cpu'}`
}

async function runMobileBenchmark (modelType, useGPU) {
  setBenchmarkEnv(modelType, useGPU)
  return runIntegrationModule('../integration/rtf-benchmark-mobile.js')
}

async function runRtfBenchmarkTdtMobileGpu (options = {}) { // eslint-disable-line no-unused-vars
  return runMobileBenchmark('tdt', true)
}

async function runRtfBenchmarkCtcMobileGpu (options = {}) { // eslint-disable-line no-unused-vars
  return runMobileBenchmark('ctc', true)
}

async function runRtfBenchmarkEouMobileGpu (options = {}) { // eslint-disable-line no-unused-vars
  return runMobileBenchmark('eou', true)
}

async function runRtfBenchmarkSortformerMobileGpu (options = {}) { // eslint-disable-line no-unused-vars
  return runMobileBenchmark('sortformer', true)
}

module.exports = {
  runRtfBenchmarkTdtMobileGpu,
  runRtfBenchmarkCtcMobileGpu,
  runRtfBenchmarkEouMobileGpu,
  runRtfBenchmarkSortformerMobileGpu
}
