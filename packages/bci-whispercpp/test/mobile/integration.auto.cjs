'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runAddonTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/addon.test.js', options)
}

async function runFitTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/fit.test.js', options)
}

async function runGpuSmokeTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/gpu-smoke.test.js', options)
}

async function runMobilePerfCpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-cpu.test.js', options)
}

async function runMobilePerfGpuTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/mobile-perf-gpu.test.js', options)
}

async function runVulkanRegressionTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/vulkan-regression.test.js', options)
}

module.exports = {
  runAddonTest,
  runFitTest,
  runGpuSmokeTest,
  runMobilePerfCpuTest,
  runMobilePerfGpuTest,
  runVulkanRegressionTest
}
