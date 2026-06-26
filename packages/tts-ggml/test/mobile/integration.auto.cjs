'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/addon.test.js', options)
}

async function runChatterboxJaMecabTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/chatterbox-ja-mecab.test.js', options)
}

async function runChatterboxKvCacheGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/chatterbox-kv-cache-gpu.test.js', options)
}

async function runChatterboxMtlTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/chatterbox-mtl.test.js', options)
}

async function runChatterboxSpeedTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/chatterbox-speed.test.js', options)
}

async function runGpuSmokeTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/gpu-smoke.test.js', options)
}

async function runMultipleRunsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multiple-runs.test.js', options)
}

async function runRtfBenchmarkTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/rtf-benchmark.test.js', options)
}

async function runStreamingBenchmarkTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/streaming-benchmark.test.js', options)
}

async function runSupertonicMtlTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/supertonic-mtl.test.js', options)
}

async function runSupertonicTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/supertonic.test.js', options)
}

async function runSupertonic3QuantTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/supertonic3-quant.test.js', options)
}

module.exports = {
  runAddonTest,
  runChatterboxJaMecabTest,
  runChatterboxKvCacheGpuTest,
  runChatterboxMtlTest,
  runChatterboxSpeedTest,
  runGpuSmokeTest,
  runMultipleRunsTest,
  runRtfBenchmarkTest,
  runStreamingBenchmarkTest,
  runSupertonicMtlTest,
  runSupertonicTest,
  runSupertonic3QuantTest
}
