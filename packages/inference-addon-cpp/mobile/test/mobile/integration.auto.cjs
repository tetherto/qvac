'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// One wrapper per desktop integration test under test/integration/.
// The harness invokes these as independent on-device tests.

/* global runIntegrationModule */

/* global __shouldRunTest */

const __FILTERED = { modulePath: 'filtered', summary: { total: 0, passed: 0, failed: 0 } }

async function runJsCreateDoubleFirstCallTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runJsCreateDoubleFirstCallTest')) return __FILTERED
  return runIntegrationModule('../integration/js-create-double-first-call/test.js', options)
}

async function runLoggerRejectTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runLoggerRejectTest')) return __FILTERED
  return runIntegrationModule('../integration/logger/reject.test.js', options)
}

async function runLoggerTeardownTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runLoggerTeardownTest')) return __FILTERED
  return runIntegrationModule('../integration/logger/teardown.test.js', options)
}

async function runLoggerTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runLoggerTest')) return __FILTERED
  return runIntegrationModule('../integration/logger/test.js', options)
}

async function runOutputCallbackLifetimeTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runOutputCallbackLifetimeTest')) return __FILTERED
  return runIntegrationModule('../integration/output-callback-lifetime/test.js', options)
}
