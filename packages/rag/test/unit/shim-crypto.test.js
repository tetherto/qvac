'use strict'

const test = require('brittle')
const cryptoShim = require('../../src/shims/crypto')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')

test('crypto shim: throws QvacErrorRAG when no crypto implementation is available', (t) => {
  const original = globalThis.crypto
  // Force the shim's resolver to find no implementation.
  delete globalThis.crypto

  try {
    const probe = cryptoShim.createHash
    t.fail(`Expected accessing a property on the shim to throw, got ${typeof probe}`)
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.DEPENDENCY_REQUIRED, 'Error code should be DEPENDENCY_REQUIRED')
    t.ok(err.message.includes('crypto-browserify'), 'Error should mention crypto-browserify')
  } finally {
    if (original !== undefined) globalThis.crypto = original
  }
})

test('crypto shim: delegates property access to globalThis.crypto when available', (t) => {
  const original = globalThis.crypto
  const stub = {
    createHash: () => 'stub',
    anything: 'value'
  }
  globalThis.crypto = stub

  try {
    t.is(typeof cryptoShim.createHash, 'function', 'createHash should be delegated as a function')
    t.is(cryptoShim.createHash(), 'stub', 'createHash invocation should return stubbed value')
    t.is(cryptoShim.anything, 'value', 'arbitrary properties should be delegated to the stub')
  } finally {
    if (original === undefined) {
      delete globalThis.crypto
    } else {
      globalThis.crypto = original
    }
  }
})

test('crypto shim: rejects self-referential global crypto', (t) => {
  const original = globalThis.crypto
  globalThis.crypto = cryptoShim

  try {
    const probe = cryptoShim.createHash
    t.fail(
      `Expected accessing a property on the self-referential shim to throw, got ${typeof probe}`
    )
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.DEPENDENCY_REQUIRED, 'Error code should be DEPENDENCY_REQUIRED')
  } finally {
    if (original === undefined) {
      delete globalThis.crypto
    } else {
      globalThis.crypto = original
    }
  }
})
