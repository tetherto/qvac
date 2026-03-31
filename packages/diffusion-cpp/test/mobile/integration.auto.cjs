'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runApiBehaviorTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/api-behavior.test.js', options)
}

async function runGenerateImageFlux2Test (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-flux2.test.js', options)
}

async function runGenerateImageSd3Test (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-sd3.test.js', options)
}

async function runGenerateImageSdxlTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-sdxl.test.js', options)
}

async function runGenerateImageTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image.test.js', options)
}

async function runModelLoadingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-loading.test.js', options)
}
