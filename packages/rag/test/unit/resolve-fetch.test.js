'use strict'

const test = require('brittle')
const resolveFetch = require('../../src/shims/resolve-fetch')
const fetchImport = require('#fetch')

test('resolveFetch: returns a callable fetch implementation', t => {
  const fetch = resolveFetch()
  t.is(typeof fetch, 'function', 'Should return a function')
})

test('resolveFetch: exposes a default export that aliases the same function', t => {
  t.is(typeof resolveFetch, 'function', 'Module export should be a function')
  t.is(resolveFetch.default, resolveFetch, 'default property should reference the same function')
})

test('resolveFetch: resolves the same fetch implementation as #fetch', t => {
  const fetch = resolveFetch()
  const expected = fetchImport.default || fetchImport
  t.is(fetch, expected, 'Should resolve through the package import map')
})
