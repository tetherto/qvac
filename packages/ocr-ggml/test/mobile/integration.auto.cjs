'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runDoctrTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/doctr.test.js', options)
}

async function runEasyocrTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/easyocr.test.js', options)
}
