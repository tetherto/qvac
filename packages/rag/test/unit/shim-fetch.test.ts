import test from 'brittle'
import fetchShim, * as fetchModule from '../../src/shims/fetch.js'
import { QvacErrorRAG, ERR_CODES } from '../../src/errors.js'

const globals = globalThis as { fetch?: (...args: unknown[]) => Promise<unknown> }

test('fetch shim: throws QvacErrorRAG when no fetch implementation is available', async (t) => {
  const original = globals.fetch
  // Force the shim's resolver to find no implementation.
  delete globals.fetch

  try {
    await fetchShim('https://example.test')
    t.fail('Expected calling the shim to throw')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.DEPENDENCY_REQUIRED, 'Error code should be DEPENDENCY_REQUIRED')
      t.ok(err.message.includes('globalThis.fetch'), 'Error should mention globalThis.fetch')
    }
  } finally {
    if (original !== undefined) globals.fetch = original
  }
})

test('fetch shim: delegates calls to globalThis.fetch when available', async (t) => {
  const original = globals.fetch
  let receivedArgs: unknown[] | undefined
  // lunte-disable-next-line require-await
  globals.fetch = async function (...args: unknown[]) {
    receivedArgs = args
    return { ok: true, url: args[0] }
  }

  try {
    const result = (await fetchShim('https://example.test', { method: 'GET' })) as {
      ok: boolean
      url: string
    }
    t.ok(result.ok, 'Proxy should return the stub response')
    t.is(result.url, 'https://example.test', 'Proxy should pass through positional args')
    t.is(receivedArgs?.[0], 'https://example.test', 'First arg forwarded to stub')
    t.alike(receivedArgs?.[1], { method: 'GET' }, 'Second arg forwarded to stub')
  } finally {
    if (original === undefined) {
      delete globals.fetch
    } else {
      globals.fetch = original
    }
  }
})

test('fetch shim: default export is the fetch function', (t) => {
  t.is(typeof fetchShim, 'function', 'Module export should be a function')
  t.is(fetchModule.default, fetchShim, 'Namespace default matches the default import')
})
