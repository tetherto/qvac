'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runApiBehaviorTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/api-behavior.test.js', options)
}

async function runBitnetTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/bitnet.test.js', options)
}

async function runCacheStateMachineTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/cache-state-machine.test.js', options)
}

async function runConfigParametersTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/config-parameters.test.js', options)
}

async function runImageTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/image.test.js', options)
}

async function runModelLoadingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-loading.test.js', options)
}

async function runMoeTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/moe.test.js', options)
}

async function runMultiInstanceTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multi-instance.test.js', options)
}

async function runOcrLightonTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/ocr-lighton.test.js', options)
}

async function runReasoningTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/reasoning.test.js', options)
}

async function runSlidingContextTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/sliding-context.test.js', options)
}

async function runToolCallingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/tool-calling.test.js', options)
}

async function runUtf8OutputTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/utf8-output.test.js', options)
}
