'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../errors')

function resolveFetch () {
  try {
    const fetchMod = require('#fetch')
    return fetchMod.default || fetchMod
  } catch (error) {
    if (error instanceof QvacErrorRAG) {
      throw error
    }
    if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new QvacErrorRAG({
        code: ERR_CODES.DEPENDENCY_REQUIRED,
        adds: 'Fetch unavailable: #fetch could not resolve. Bare: install bare-fetch; otherwise ensure globalThis.fetch exists and your bundler supports package imports.',
        cause: error
      })
    }
    throw error
  }
}

module.exports = resolveFetch
module.exports.default = resolveFetch
