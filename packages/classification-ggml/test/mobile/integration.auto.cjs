'use strict'
require('./integration-runtime.cjs')

/* global runIntegrationModule */

async function runBridgedepth (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/bridgedepth.test.js', options)
}

async function runClassify (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/classify.test.js', options)
}

async function runErrorCases (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/error-cases.test.js', options)
}

async function runFit (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/fit.test.js', options)
}

async function runMegaloc (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/megaloc.test.js', options)
}
