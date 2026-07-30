'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../errors')

function ensureCrypto() {
  const crypto = typeof globalThis !== 'undefined' ? globalThis.crypto : null
  if (crypto && crypto !== module.exports && typeof crypto.createHash === 'function') {
    return crypto
  }
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No Node-style crypto implementation available. This code path requires globalThis.crypto.createHash, including HyperDB document hashing. Bare: install bare-crypto. Node: node:crypto is used by the package import map. Browser/RN: install and configure crypto-browserify, or another createHash-compatible polyfill, before using APIs that depend on #crypto.'
  })
}

const cryptoShim = new Proxy(
  {},
  {
    get(_target, prop) {
      return ensureCrypto()[prop]
    },
    has(_target, prop) {
      try {
        return prop in ensureCrypto()
      } catch {
        return false
      }
    }
  }
)

module.exports = cryptoShim
