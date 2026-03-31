'use strict'
require('./integration-runtime.cjs')

/* global runIntegrationModule */

async function runBergamot (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/bergamot.test.js', options)
}

async function runIndictrans (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/indictrans.test.js', options)
}
