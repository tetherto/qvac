'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */
/* global shouldRunMobileTest, createSkippedMobileTestResult */

async function runAccuracyMultilangTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runAccuracyMultilangTest')) return createSkippedMobileTestResult('runAccuracyMultilangTest')
  return runIntegrationModule('../integration/accuracy-multilang.test.js', options)
}

async function runAddonMultimodelTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runAddonMultimodelTest')) return createSkippedMobileTestResult('runAddonMultimodelTest')
  return runIntegrationModule('../integration/addon-multimodel.test.js', options)
}

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runAddonTest')) return createSkippedMobileTestResult('runAddonTest')
  return runIntegrationModule('../integration/addon.test.js', options)
}

async function runColdStartTimingTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runColdStartTimingTest')) return createSkippedMobileTestResult('runColdStartTimingTest')
  return runIntegrationModule('../integration/cold-start-timing.test.js', options)
}

async function runCorruptedModelTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runCorruptedModelTest')) return createSkippedMobileTestResult('runCorruptedModelTest')
  return runIntegrationModule('../integration/corrupted-model.test.js', options)
}

async function runIndividualFilePathsTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runIndividualFilePathsTest')) return createSkippedMobileTestResult('runIndividualFilePathsTest')
  return runIntegrationModule('../integration/individual-file-paths.test.js', options)
}

async function runLiveStreamSimulationTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runLiveStreamSimulationTest')) return createSkippedMobileTestResult('runLiveStreamSimulationTest')
  return runIntegrationModule('../integration/live-stream-simulation.test.js', options)
}

async function runModelFileValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runModelFileValidationTest')) return createSkippedMobileTestResult('runModelFileValidationTest')
  return runIntegrationModule('../integration/model-file-validation.test.js', options)
}

async function runMultipleTranscriptionsTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runMultipleTranscriptionsTest')) return createSkippedMobileTestResult('runMultipleTranscriptionsTest')
  return runIntegrationModule('../integration/multiple-transcriptions.test.js', options)
}

async function runNamedPathsAllModelsTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runNamedPathsAllModelsTest')) return createSkippedMobileTestResult('runNamedPathsAllModelsTest')
  return runIntegrationModule('../integration/named-paths-all-models.test.js', options)
}

async function runNamedPathsReloadTest (options = {}) { // eslint-disable-line no-unused-vars
  if (!shouldRunMobileTest('runNamedPathsReloadTest')) return createSkippedMobileTestResult('runNamedPathsReloadTest')
  return runIntegrationModule('../integration/named-paths-reload.test.js', options)
}
