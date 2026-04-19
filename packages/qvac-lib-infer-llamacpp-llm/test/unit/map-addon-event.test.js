'use strict'

const test = require('brittle')
const { mapAddonEvent } = require('../../addon.js')

function makeState (overrides = {}) {
  return { skipNextRuntimeStats: false, ...overrides }
}

test('TPS-shaped data maps to JobEnded with mapped backendDevice (cpu)', function (t) {
  const state = makeState()
  const result = mapAddonEvent('anything', { TPS: 42, tokens: 10, backendDevice: 0 }, null, state)
  t.is(result.type, 'JobEnded')
  t.is(result.data.TPS, 42)
  t.is(result.data.backendDevice, 'cpu')
  t.is(result.error, null)
  t.is(state.skipNextRuntimeStats, false, 'flag remains false after normal inference terminal')
})

test('TPS-shaped data maps backendDevice 1 to "gpu"', function (t) {
  const state = makeState()
  const result = mapAddonEvent('anything', { TPS: 50, backendDevice: 1 }, null, state)
  t.is(result.data.backendDevice, 'gpu')
})

test('TPS-shaped data preserves unknown backendDevice values as-is', function (t) {
  const state = makeState()
  const result = mapAddonEvent('anything', { TPS: 1, backendDevice: 2 }, null, state)
  t.is(result.data.backendDevice, 2)
})

test('TPS-shaped data is dropped when skipNextRuntimeStats is set', function (t) {
  const state = makeState({ skipNextRuntimeStats: true })
  const result = mapAddonEvent('anything', { TPS: 99 }, null, state)
  t.is(result, null, 'returns null to drop stale post-finetune TPS')
  t.is(state.skipNextRuntimeStats, false, 'flag resets after consuming')
})

test('finetune terminal payload maps to JobEnded and arms skip flag', function (t) {
  const state = makeState()
  const payload = { op: 'finetune', status: 'COMPLETED', stats: { loss: 0.1 } }
  const result = mapAddonEvent('anything', payload, null, state)
  t.is(result.type, 'JobEnded')
  t.is(result.data, payload)
  t.is(state.skipNextRuntimeStats, true, 'skip flag armed to swallow the TPS trailer')
})

test('finetune_progress payload maps to FinetuneProgress', function (t) {
  const state = makeState()
  const payload = { type: 'finetune_progress', stats: { loss: 0.2 } }
  const result = mapAddonEvent('anything', payload, null, state)
  t.is(result.type, 'FinetuneProgress')
  t.is(result.data, payload)
})

test('event name containing "Error" maps to Error with rawError', function (t) {
  const state = makeState()
  const err = new Error('boom')
  const result = mapAddonEvent('SomeError', null, err, state)
  t.is(result.type, 'Error')
  t.is(result.error, err)
})

test('string data maps to Output (token streaming)', function (t) {
  const state = makeState()
  const result = mapAddonEvent('OutputString', 'hello', null, state)
  t.is(result.type, 'Output')
  t.is(result.data, 'hello')
})

test('event name containing "LogMsg" maps to LogMsg (string payload not remapped to Output)', function (t) {
  const state = makeState()
  const result = mapAddonEvent('SomeLogMsg', 'native log line', null, state)
  t.is(result.type, 'LogMsg', 'LogMsg event name wins over string-to-Output fallback')
  t.is(result.data, 'native log line')
})

test('unknown event with non-TPS object falls through to default mapping', function (t) {
  const state = makeState()
  const result = mapAddonEvent('Unknown', { foo: 'bar' }, null, state)
  t.is(result.type, 'Unknown', 'falls through preserving original event name')
  t.alike(result.data, { foo: 'bar' })
})
