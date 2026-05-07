'use strict'
require('./integration-runtime.cjs')

// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.
// Each function mirrors a single file under test/integration/.

/* global runIntegrationModule */

async function runApiBehaviorTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/api-behavior.test.js', options)
}

async function runGenerateImageFlux2FusionSurjectiveTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-flux2-fusion-surjective.test.js', options)
}

async function runGenerateImageFlux2FusionTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-flux2-fusion.test.js', options)
}

async function runGenerateImageFlux2I2iTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-flux2-i2i.test.js', options)
}

async function runGenerateImageFlux2Test (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-flux2.test.js', options)
}

async function runGenerateImageSd3I2iTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-sd3-i2i.test.js', options)
}

async function runGenerateImageSd3Test (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-sd3.test.js', options)
}

async function runGenerateImageSdxlTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image-sdxl.test.js', options)
}

async function runGenerateImageTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/generate-image.test.js', options)
}

async function runInputValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/input-validation.test.js', options)
}

async function runLoraBridgeTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/lora-bridge.test.js', options)
}

async function runModelLoadingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-loading.test.js', options)
}

module.exports = {
  runApiBehaviorTest,
  runGenerateImageFlux2FusionSurjectiveTest,
  runGenerateImageFlux2FusionTest,
  runGenerateImageFlux2I2iTest,
  runGenerateImageFlux2Test,
  runGenerateImageSd3I2iTest,
  runGenerateImageSd3Test,
  runGenerateImageSdxlTest,
  runGenerateImageTest,
  runInputValidationTest,
  runLoraBridgeTest,
  runModelLoadingTest
}
