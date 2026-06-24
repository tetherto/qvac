'use strict'
require('./integration-runtime.cjs')

/* global runIntegrationModule */

async function runAccuracyMultilangTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/accuracy-multilang.test.js', options)
}

async function runAudioCtxChunkingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/audio-ctx-chunking.test.js', options)
}

async function runColdStartTimingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/cold-start-timing.test.js', options)
}

async function runCorruptedModelTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/corrupted-model.test.js', options)
}

async function runGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/gpu.test.js', options)
}

async function runLiveStreamSimulationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/live-stream-simulation.test.js', options)
}

async function runLongEsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/longES.test.js', options)
}

async function runMobilePerfTinyCpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-tiny-cpu.test.js', options)
}

async function runModelFileValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-file-validation.test.js', options)
}

async function runMultipleTranscriptionsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multiple-transcriptions.test.js', options)
}

// Intentionally ordered LAST (not alphabetically): the GPU teardown can crash
// the bare app on some Adreno devices at process/context shutdown
// (whisper.cpp#2373). Keeping it as the final case ensures such a crash cannot
// drop coverage of any earlier test on that device. See
// test/integration/mobile-perf-tiny-gpu.test.js for the full rationale.
async function runMobilePerfTinyGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-tiny-gpu.test.js', options)
}

module.exports = {
  runAccuracyMultilangTest,
  runAudioCtxChunkingTest,
  runColdStartTimingTest,
  runCorruptedModelTest,
  runGpuTest,
  runLiveStreamSimulationTest,
  runLongEsTest,
  runMobilePerfTinyCpuTest,
  runMobilePerfTinyGpuTest,
  runModelFileValidationTest,
  runMultipleTranscriptionsTest
}
