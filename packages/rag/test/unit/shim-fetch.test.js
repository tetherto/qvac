'use strict'

const test = require('brittle')
const fetchShim = require('../../src/shims/fetch')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')

test('fetch shim: throws QvacErrorRAG when no fetch implementation is available', async t => {
  const original = globalThis.fetch
  // Force the shim's resolver to find no implementation.
  delete globalThis.fetch

  try {
    await fetchShim('https://example.test')
    t.fail('Expected calling the shim to throw')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.DEPENDENCY_REQUIRED, 'Error code should be DEPENDENCY_REQUIRED')
    t.ok(err.message.includes('globalThis.fetch'), 'Error should mention globalThis.fetch')
  } finally {
    if (original !== undefined) globalThis.fetch = original
  }
})

test('fetch shim: delegates calls to globalThis.fetch when available', async t => {
  const original = globalThis.fetch
  let receivedArgs
  globalThis.fetch = async function stub (...args) {
    receivedArgs = args
    return { ok: true, url: args[0] }
  }

  try {
    const result = await fetchShim('https://example.test', { method: 'GET' })
    t.ok(result.ok, 'Proxy should return the stub response')
    t.is(result.url, 'https://example.test', 'Proxy should pass through positional args')
    t.is(receivedArgs[0], 'https://example.test', 'First arg forwarded to stub')
    t.alike(receivedArgs[1], { method: 'GET' }, 'Second arg forwarded to stub')
  } finally {
    if (original === undefined) {
      delete globalThis.fetch
    } else {
      globalThis.fetch = original
    }
  }
})

test('fetch shim: exposes a default export that aliases the same function', t => {
  t.is(typeof fetchShim, 'function', 'Module export should be a function')
  t.is(fetchShim.default, fetchShim, 'default property should reference the same function')
})
