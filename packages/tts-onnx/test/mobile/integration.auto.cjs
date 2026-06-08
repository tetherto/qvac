'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/addon.test.js', options)
}

async function runRtfBenchmarkTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/rtf-benchmark.test.js', options)
}

async function runStreamingBenchmarkTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/streaming-benchmark.test.js', options)
}
