'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runChatterboxToneCpuMtlTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/chatterbox-tone-cpu-mtl.test.js', options)
}

async function runChatterboxToneCpuTurboTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/chatterbox-tone-cpu-turbo.test.js', options)
}

module.exports = {
  runChatterboxToneCpuMtlTest,
  runChatterboxToneCpuTurboTest
}
