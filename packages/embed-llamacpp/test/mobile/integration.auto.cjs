'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/addon.test.js', options)
}

async function runMultiInstanceTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multi-instance.test.js', options)
}
