'use strict'

const test = require('brittle')
const { mapAddonEvent } = require('../../addon.js')

test('TPS-shaped data maps to JobEnded with mapped backendDevice (cpu)', function (t) {
  const result = mapAddonEvent('anything', { TPS: 42, tokens: 10, backendDevice: 0 }, null)
  t.is(result.type, 'JobEnded')
  t.is(result.data.TPS, 42)
  t.is(result.data.backendDevice, 'cpu')
  t.is(result.error, null)
})

test('TPS-shaped data maps backendDevice 1 to "gpu"', function (t) {
  const result = mapAddonEvent('anything', { TPS: 50, backendDevice: 1 }, null)
  t.is(result.data.backendDevice, 'gpu')
})

test('TPS-shaped data preserves unknown backendDevice values as-is', function (t) {
  const result = mapAddonEvent('anything', { TPS: 1, backendDevice: 2 }, null)
  t.is(result.data.backendDevice, 2)
})

// stopReason rides the per-job stats on both the sequential and the concurrent
// path. It is index-matched to the C++ GenerationStopReason enum, and absent
// when the native side could not attribute one (e.g. a batch group whose
// requests ended differently) — so the mapping must stay guarded on `number`.

test('numeric stopReason maps to its label', function (t) {
  const result = mapAddonEvent('anything', { TPS: 1, stopReason: 3 }, null)
  t.is(
    result.data.stopReason,
    'predictionLimit',
    'index 3 must map to predictionLimit (what reasoning.test.js discriminates on)'
  )
})

test('out-of-range stopReason falls back to "none"', function (t) {
  const result = mapAddonEvent('anything', { TPS: 1, stopReason: 99 }, null)
  t.is(result.data.stopReason, 'none')
})

test('absent stopReason stays absent rather than becoming a label', function (t) {
  const result = mapAddonEvent('anything', { TPS: 1 }, null)
  t.absent('stopReason' in result.data, 'a stats payload without stopReason must not gain one')
})

test('finetune terminal payload maps to JobEnded', function (t) {
  const payload = { op: 'finetune', status: 'COMPLETED', stats: { loss: 0.1 } }
  const result = mapAddonEvent('anything', payload, null)
  t.is(result.type, 'JobEnded')
  t.is(result.data, payload)
})

test('finetune_progress payload maps to FinetuneProgress', function (t) {
  const payload = { type: 'finetune_progress', stats: { loss: 0.2 } }
  const result = mapAddonEvent('anything', payload, null)
  t.is(result.type, 'FinetuneProgress')
  t.is(result.data, payload)
})

test('event name containing "Error" maps to Error with rawError', function (t) {
  const err = new Error('boom')
  const result = mapAddonEvent('SomeError', null, err)
  t.is(result.type, 'Error')
  t.is(result.error, err)
})

test('string data maps to Output (token streaming)', function (t) {
  const result = mapAddonEvent('OutputString', 'hello', null)
  t.is(result.type, 'Output')
  t.is(result.data, 'hello')
})

test('event name containing "LogMsg" maps to LogMsg (string payload not remapped to Output)', function (t) {
  const result = mapAddonEvent('SomeLogMsg', 'native log line', null)
  t.is(result.type, 'LogMsg', 'LogMsg event name wins over string-to-Output fallback')
  t.is(result.data, 'native log line')
})

test('unknown event with non-TPS object falls through to default mapping', function (t) {
  const result = mapAddonEvent('Unknown', { foo: 'bar' }, null)
  t.is(result.type, 'Unknown', 'falls through preserving original event name')
  t.alike(result.data, { foo: 'bar' })
})
