'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.
// Functions are invoked dynamically by the mobile test runner framework.

/* global runIntegrationModule */

/* global __shouldRunTest */

const __FILTERED = { modulePath: 'filtered', summary: { total: 0, passed: 0, failed: 0 } }

async function runAfriquegemmaEdgeCasesTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runAfriquegemmaEdgeCasesTest')) return __FILTERED
  return runIntegrationModule('../integration/afriquegemma-edge-cases.test.js', options)
}

async function runAfriquegemmaTranslationTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runAfriquegemmaTranslationTest')) return __FILTERED
  return runIntegrationModule('../integration/afriquegemma-translation.test.js', options)
}

async function runApiBehaviorTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runApiBehaviorTest')) return __FILTERED
  return runIntegrationModule('../integration/api-behavior.test.js', options)
}

async function runBitnetTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runBitnetTest')) return __FILTERED
  return runIntegrationModule('../integration/bitnet.test.js', options)
}

async function runCacheStateMachineTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runCacheStateMachineTest')) return __FILTERED
  return runIntegrationModule('../integration/cache-state-machine.test.js', options)
}

async function runConfigParametersTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runConfigParametersTest')) return __FILTERED
  return runIntegrationModule('../integration/config-parameters.test.js', options)
}

async function runDynamicToolsTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runDynamicToolsTest')) return __FILTERED
  return runIntegrationModule('../integration/dynamic-tools.test.js', options)
}

async function runFinetuningPauseResumeTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runFinetuningPauseResumeTest')) return __FILTERED
  return runIntegrationModule('../integration/finetuning-pause-resume.test.js', options)
}

async function runGenerationParamsTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runGenerationParamsTest')) return __FILTERED
  return runIntegrationModule('../integration/generation-params.test.js', options)
}

async function runImageTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runImageTest')) return __FILTERED
  return runIntegrationModule('../integration/image.test.js', options)
}

async function runModelLoadingTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runModelLoadingTest')) return __FILTERED
  return runIntegrationModule('../integration/model-loading.test.js', options)
}

async function runMoeTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runMoeTest')) return __FILTERED
  return runIntegrationModule('../integration/moe.test.js', options)
}

async function runMultiInstanceTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runMultiInstanceTest')) return __FILTERED
  return runIntegrationModule('../integration/multi-instance.test.js', options)
}

async function runOcrLightonTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runOcrLightonTest')) return __FILTERED
  return runIntegrationModule('../integration/ocr-lighton.test.js', options)
}

async function runReasoningTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runReasoningTest')) return __FILTERED
  return runIntegrationModule('../integration/reasoning.test.js', options)
}

async function runSlidingContextTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runSlidingContextTest')) return __FILTERED
  return runIntegrationModule('../integration/sliding-context.test.js', options)
}

async function runToolCallingTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runToolCallingTest')) return __FILTERED
  return runIntegrationModule('../integration/tool-calling.test.js', options)
}

async function runUtf8OutputTest (options = {}) { // eslint-disable-line no-unused-vars
  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('runUtf8OutputTest')) return __FILTERED
  return runIntegrationModule('../integration/utf8-output.test.js', options)
}
