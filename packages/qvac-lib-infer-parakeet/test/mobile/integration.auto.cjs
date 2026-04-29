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

async function runExternalDataStagingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/external-data-staging.test.js', options)
}

async function runIndividualFilePathsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/individual-file-paths.test.js', options)
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

module.exports = {
  runAccuracyMultilangTest,
  runAddonMultimodelTest,
  runAddonTest,
  runColdStartTimingTest,
  runCorruptedModelTest,
  runExternalDataStagingTest,
  runIndividualFilePathsTest,
  runLiveStreamSimulationTest,
  runMobilePerfCtcCpuTest,
  runMobilePerfCtcGpuTest,
  runMobilePerfEouCpuTest,
  runMobilePerfEouGpuTest,
  runMobilePerfSortformerCpuTest,
  runMobilePerfSortformerGpuTest,
  runModelFileValidationTest,
  runMultipleTranscriptionsTest,
  runNamedPathsAllModelsTest,
  runNamedPathsReloadTest
}
