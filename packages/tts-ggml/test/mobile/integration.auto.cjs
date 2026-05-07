'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/addon.test.js', options)
}

async function runChatterboxMtlTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/chatterbox-mtl.test.js', options)
}

async function runGpuSmokeTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/gpu-smoke.test.js', options)
}

async function runMultipleRunsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multiple-runs.test.js', options)
}

async function runSupertonicMtlTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/supertonic-mtl.test.js', options)
}

async function runSupertonicTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/supertonic.test.js', options)
}

module.exports = {
  runAddonTest,
  runChatterboxMtlTest,
  runGpuSmokeTest,
  runMultipleRunsTest,
  runSupertonicMtlTest,
  runSupertonicTest
}
