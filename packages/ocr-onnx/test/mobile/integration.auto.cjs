'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runErrorHandlingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/error-handling.test.js', options)
}

async function runFullCoverageTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/full-coverage.test.js', options)
}

async function runFullOcrSuiteTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/full-ocr-suite.test.js', options)
}

async function runImageFormatsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/image-formats.test.js', options)
}

async function runLargeImagesTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/large-images.test.js', options)
}

async function runLifecycleTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/lifecycle.test.js', options)
}

async function runOcrBasicTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/ocr-basic.test.js', options)
}

async function runParamValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/param-validation.test.js', options)
}

async function runPipelineTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/pipeline.test.js', options)
}
