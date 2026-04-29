'use strict'
require('../mobile/integration-runtime.cjs')

/* global runIntegrationModule */

async function runRtfBenchmarkTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-rtf-benchmark.test.js', options)
}
