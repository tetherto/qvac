'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../errors')

function ensureCrypto () {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.createHash === 'function') {
    return globalThis.crypto
  }
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No crypto implementation found. Please ensure a crypto module is available in your environment (Bare: bare-crypto; Node: node:crypto; other: provide a Web Crypto-compatible globalThis.crypto).'
  })
}

module.exports = new Proxy({}, {
  get (_target, prop) {
    return ensureCrypto()[prop]
  },
  has (_target, prop) {
    try { return prop in ensureCrypto() } catch { return false }
  }
})
