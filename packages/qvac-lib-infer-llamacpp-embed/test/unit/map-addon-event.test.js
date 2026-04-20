'use strict'

const test = require('brittle')
const { mapAddonEvent } = require('../../addon.js')

test('stats payload with tokens_per_second maps to JobEnded', function (t) {
  const result = mapAddonEvent('Stats', { tokens_per_second: 123, total_tokens: 10 }, null)
  t.is(result.type, 'JobEnded')
  t.is(result.data.tokens_per_second, 123)
  t.is(result.data.total_tokens, 10)
  t.is(result.error, null)
})

test('stats payload maps backendDevice 0 to "cpu"', function (t) {
  const result = mapAddonEvent('Stats', { total_time_ms: 5, backendDevice: 0 }, null)
  t.is(result.type, 'JobEnded')
  t.is(result.data.backendDevice, 'cpu')
})

test('stats payload maps backendDevice 1 to "gpu"', function (t) {
  const result = mapAddonEvent('Stats', { batch_size: 32, backendDevice: 1 }, null)
  t.is(result.type, 'JobEnded')
  t.is(result.data.backendDevice, 'gpu')
})

test('stats payload leaves unknown backendDevice values as-is', function (t) {
  const result = mapAddonEvent('Stats', { context_size: 512, backendDevice: 2 }, null)
  t.is(result.type, 'JobEnded')
  t.is(result.data.backendDevice, 2)
})

test('Error event name maps to Error type carrying rawError', function (t) {
  const err = new Error('boom')
  const result = mapAddonEvent('SomeError', null, err)
  t.is(result.type, 'Error')
  t.is(result.error, err)
})

test('Embeddings event name maps to Output type', function (t) {
  const data = [[0.1, 0.2, 0.3]]
  const result = mapAddonEvent('Embeddings', data, null)
  t.is(result.type, 'Output')
  t.is(result.data, data)
  t.is(result.error, null)
})

test('stats detection takes precedence over event name', function (t) {
  const result = mapAddonEvent('Embeddings', { tokens_per_second: 99 }, null)
  t.is(result.type, 'JobEnded', 'stats-shaped data overrides Embeddings event')
})

test('unknown event with non-stats object returns null', function (t) {
  const result = mapAddonEvent('Unknown', { foo: 'bar' }, null)
  t.is(result, null)
})

test('unknown event with primitive data returns null', function (t) {
  t.is(mapAddonEvent('Unknown', 'string', null), null)
  t.is(mapAddonEvent('Unknown', 42, null), null)
  t.is(mapAddonEvent('Unknown', null, null), null)
})
