'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.
// Functions are invoked dynamically by the mobile test runner framework.

/* global runIntegrationModule */

/* global __shouldRunTest */

const __FILTERED = { modulePath: 'filtered', summary: { total: 0, passed: 0, failed: 0 } }

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runAddonTest')) return __FILTERED
  return runIntegrationModule('../integration/addon.test.js', options)
}
