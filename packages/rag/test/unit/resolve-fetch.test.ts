import test from 'brittle'
import resolveFetch, * as resolveFetchModule from '../../src/shims/resolve-fetch.js'
import * as fetchImport from '#fetch'

test('resolveFetch: returns a callable fetch implementation', async (t) => {
  const fetch = await resolveFetch()
  t.is(typeof fetch, 'function', 'Should return a function')
})

test('resolveFetch: default export is the resolveFetch function', (t) => {
  t.is(typeof resolveFetch, 'function', 'Module export should be a function')
  t.is(resolveFetchModule.default, resolveFetch, 'Namespace default matches the default import')
})

test('resolveFetch: resolves the same fetch implementation as #fetch', async (t) => {
  const fetch = await resolveFetch()
  const expected = fetchImport.default || fetchImport
  t.is(fetch, expected, 'Should resolve through the package import map')
})
