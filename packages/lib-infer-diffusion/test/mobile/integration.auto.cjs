'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runGenerateImageTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image.test.js', options)
}

async function runModelLoadingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-loading.test.js', options)
}
