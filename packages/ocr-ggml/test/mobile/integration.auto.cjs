'use strict'
require('./integration-runtime.cjs')

/* global runIntegrationModule */

async function runDoctr (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/doctr.test.js', options)
}

async function runEasyocr (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/easyocr.test.js', options)
}
