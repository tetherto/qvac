import test from 'brittle'
import cryptoShim from '../../src/shims/crypto.js'
import { QvacErrorRAG, ERR_CODES } from '../../src/errors.js'

const globals = globalThis as { crypto?: unknown }

test('crypto shim: throws QvacErrorRAG when no crypto implementation is available', (t) => {
  const original = globals.crypto
  // Force the shim's resolver to find no implementation.
  delete globals.crypto

  try {
    const probe = cryptoShim.createHash
    t.fail(`Expected accessing a property on the shim to throw, got ${typeof probe}`)
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.DEPENDENCY_REQUIRED, 'Error code should be DEPENDENCY_REQUIRED')
      t.ok(err.message.includes('crypto-browserify'), 'Error should mention crypto-browserify')
    }
  } finally {
    if (original !== undefined) globals.crypto = original
  }
})

test('crypto shim: delegates property access to globalThis.crypto when available', (t) => {
  const original = globals.crypto
  const stub = {
    createHash: () => 'stub',
    anything: 'value'
  }
  globals.crypto = stub

  const shim = cryptoShim as unknown as { createHash(): unknown; anything: unknown }
  try {
    t.is(typeof shim.createHash, 'function', 'createHash should be delegated as a function')
    t.is(shim.createHash(), 'stub', 'createHash invocation should return stubbed value')
    t.is(shim.anything, 'value', 'arbitrary properties should be delegated to the stub')
  } finally {
    if (original === undefined) {
      delete globals.crypto
    } else {
      globals.crypto = original
    }
  }
})

test('crypto shim: rejects self-referential global crypto', (t) => {
  const original = globals.crypto
  globals.crypto = cryptoShim

  try {
    const probe = cryptoShim.createHash
    t.fail(
      `Expected accessing a property on the self-referential shim to throw, got ${typeof probe}`
    )
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.DEPENDENCY_REQUIRED, 'Error code should be DEPENDENCY_REQUIRED')
    }
  } finally {
    if (original === undefined) {
      delete globals.crypto
    } else {
      globals.crypto = original
    }
  }
})
