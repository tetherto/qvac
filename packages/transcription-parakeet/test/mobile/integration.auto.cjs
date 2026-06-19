'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runAccuracyMultilangTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/accuracy-multilang.test.js', options)
}

async function runAddonMultimodelTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/addon-multimodel.test.js', options)
}

async function runColdStartTimingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/cold-start-timing.test.js', options)
}

async function runCorruptedModelTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/corrupted-model.test.js', options)
}

async function runDuplexStreamingEouTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/duplex-streaming-eou.test.js', options)
}

async function runDuplexStreamingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/duplex-streaming.test.js', options)
}

async function runEouStreamingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/eou-streaming.test.js', options)
}

async function runGpuSmokeTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/gpu-smoke.test.js', options)
}

async function runLiveStreamSimulationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/live-stream-simulation.test.js', options)
}

async function runMobilePerfCtcCpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-ctc-cpu.test.js', options)
}

async function runMobilePerfCtcGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-ctc-gpu.test.js', options)
}

async function runMobilePerfEouCpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-eou-cpu.test.js', options)
}

async function runMobilePerfEouGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-eou-gpu.test.js', options)
}

async function runMobilePerfSortformerCpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-sortformer-cpu.test.js', options)
}

async function runMobilePerfSortformerGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-sortformer-gpu.test.js', options)
}

async function runMobilePerfTdtCpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-tdt-cpu.test.js', options)
}

async function runMobilePerfTdtGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-tdt-gpu.test.js', options)
}

async function runModelFileValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-file-validation.test.js', options)
}

async function runMultipleTranscriptionsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multiple-transcriptions.test.js', options)
}

async function runSortformerAoscStreamingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/sortformer-aosc-streaming.test.js', options)
}

module.exports = {
  runAccuracyMultilangTest,
  runAddonMultimodelTest,
  runColdStartTimingTest,
  runCorruptedModelTest,
  runDuplexStreamingEouTest,
  runDuplexStreamingTest,
  runEouStreamingTest,
  runGpuSmokeTest,
  runLiveStreamSimulationTest,
  runMobilePerfCtcCpuTest,
  runMobilePerfCtcGpuTest,
  runMobilePerfEouCpuTest,
  runMobilePerfEouGpuTest,
  runMobilePerfSortformerCpuTest,
  runMobilePerfSortformerGpuTest,
  runMobilePerfTdtCpuTest,
  runMobilePerfTdtGpuTest,
  runModelFileValidationTest,
  runMultipleTranscriptionsTest,
  runSortformerAoscStreamingTest
}
