'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../errors')

function ensureFetch () {
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis)
  }
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No fetch implementation found. Please ensure a Fetch-compatible globalThis.fetch is available. Bare: install bare-fetch. Node 18+ and browser/RN environments normally provide fetch globally.'
  })
}

function fetchProxy (...args) {
  return ensureFetch()(...args)
}

module.exports = fetchProxy
module.exports.default = fetchProxy
