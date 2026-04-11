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

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/addon.test.js', options)
}

async function runColdStartTimingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/cold-start-timing.test.js', options)
}

async function runCorruptedModelTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/corrupted-model.test.js', options)
}

async function runIndividualFilePathsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/individual-file-paths.test.js', options)
}

async function runLiveStreamSimulationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/live-stream-simulation.test.js', options)
}

async function runModelFileValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-file-validation.test.js', options)
}

async function runMultipleTranscriptionsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multiple-transcriptions.test.js', options)
}

async function runNamedPathsAllModelsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/named-paths-all-models.test.js', options)
}

async function runNamedPathsReloadTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/named-paths-reload.test.js', options)
}
