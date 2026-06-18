'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.
// Functions are invoked dynamically by the mobile test runner framework.

/* global runIntegrationModule */

/* global __shouldRunTest */

const __FILTERED = { modulePath: 'filtered', summary: { total: 0, passed: 0, failed: 0 } }

async function runAndroidOpenclTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runAndroidOpenclTest')) return __FILTERED
  return runIntegrationModule('../integration/android-opencl.test.js', options)
}

async function runAndroidVulkanTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runAndroidVulkanTest')) return __FILTERED
  return runIntegrationModule('../integration/android-vulkan.test.js', options)
}

async function runBackendDeviceTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runBackendDeviceTest')) return __FILTERED
  return runIntegrationModule('../integration/backend-device.test.js', options)
}

async function runBatchedRecognizerTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runBatchedRecognizerTest')) return __FILTERED
  return runIntegrationModule('../integration/batched-recognizer.test.js', options)
}

async function runBiasBroadcastTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runBiasBroadcastTest')) return __FILTERED
  return runIntegrationModule('../integration/bias-broadcast.test.js', options)
}

async function runCanvasSizeTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runCanvasSizeTest')) return __FILTERED
  return runIntegrationModule('../integration/canvas-size.test.js', options)
}

async function runConv1x1MulmatTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runConv1x1MulmatTest')) return __FILTERED
  return runIntegrationModule('../integration/conv1x1-mulmat.test.js', options)
}

async function runCrnnBiasBroadcastTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runCrnnBiasBroadcastTest')) return __FILTERED
  return runIntegrationModule('../integration/crnn-bias-broadcast.test.js', options)
}

async function runDoctrBasicTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDoctrBasicTest')) return __FILTERED
  return runIntegrationModule('../integration/doctr-basic.test.js', options)
}

async function runDoctrClinicalChemistryTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDoctrClinicalChemistryTest')) return __FILTERED
  return runIntegrationModule('../integration/doctr-clinical-chemistry.test.js', options)
}

async function runDoctrCtScanTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDoctrCtScanTest')) return __FILTERED
  return runIntegrationModule('../integration/doctr-ct-scan.test.js', options)
}

async function runDoctrLabResultsTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDoctrLabResultsTest')) return __FILTERED
  return runIntegrationModule('../integration/doctr-lab-results.test.js', options)
}

async function runDoctrLiverFunctionTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDoctrLiverFunctionTest')) return __FILTERED
  return runIntegrationModule('../integration/doctr-liver-function.test.js', options)
}

async function runDoctrModelsTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDoctrModelsTest')) return __FILTERED
  return runIntegrationModule('../integration/doctr-models.test.js', options)
}

async function runDoctrParamValidationTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDoctrParamValidationTest')) return __FILTERED
  return runIntegrationModule('../integration/doctr-param-validation.test.js', options)
}

async function runErrorHandlingTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runErrorHandlingTest')) return __FILTERED
  return runIntegrationModule('../integration/error-handling.test.js', options)
}

async function runFullCoverageTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runFullCoverageTest')) return __FILTERED
  return runIntegrationModule('../integration/full-coverage.test.js', options)
}

async function runFullOcrSuiteTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runFullOcrSuiteTest')) return __FILTERED
  return runIntegrationModule('../integration/full-ocr-suite.test.js', options)
}

async function runImageFormatsTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runImageFormatsTest')) return __FILTERED
  return runIntegrationModule('../integration/image-formats.test.js', options)
}

async function runKernelPrecisionTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runKernelPrecisionTest')) return __FILTERED
  return runIntegrationModule('../integration/kernel-precision.test.js', options)
}

async function runLargeImagesTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runLargeImagesTest')) return __FILTERED
  return runIntegrationModule('../integration/large-images.test.js', options)
}

async function runLifecycleTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runLifecycleTest')) return __FILTERED
  return runIntegrationModule('../integration/lifecycle.test.js', options)
}

async function runOcrBasicTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runOcrBasicTest')) return __FILTERED
  return runIntegrationModule('../integration/ocr-basic.test.js', options)
}

async function runOpenclBackendTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runOpenclBackendTest')) return __FILTERED
  return runIntegrationModule('../integration/opencl-backend.test.js', options)
}

async function runParamValidationTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runParamValidationTest')) return __FILTERED
  return runIntegrationModule('../integration/param-validation.test.js', options)
}

async function runPipelineTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runPipelineTest')) return __FILTERED
  return runIntegrationModule('../integration/pipeline.test.js', options)
}

async function runRunInternalOrderingTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runRunInternalOrderingTest')) return __FILTERED
  return runIntegrationModule('../integration/run-internal-ordering.test.js', options)
}
