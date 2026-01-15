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

async function runLiveStreamSimulationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/live-stream-simulation.test.js', options)
}

async function runLongEsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/longES.test.js', options)
}

async function runModelFileValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-file-validation.test.js', options)
}

async function runMultipleTranscriptionsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multiple-transcriptions.test.js', options)
}
