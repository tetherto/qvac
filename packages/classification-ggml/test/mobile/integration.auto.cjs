'use strict'
require('./integration-runtime.cjs')

/* global runIntegrationModule */

async function runClassify (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/classify.test.js', options)
}

async function runErrorCases (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/error-cases.test.js', options)
}
