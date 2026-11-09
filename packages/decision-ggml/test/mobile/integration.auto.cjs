'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

/* global __shouldRunTest */

const __FILTERED = { modulePath: 'filtered', summary: { total: 0, passed: 0, failed: 0 } }

async function runDecisionEngineTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDecisionEngineTest')) return __FILTERED
  return runIntegrationModule('../integration/decision-engine.test.js', options)
}

async function runLayaTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runLayaTest')) return __FILTERED
  return runIntegrationModule('../integration/laya.test.js', options)
}
