'use strict'

const test = require('brittle')
const { mapAddonEvent } = require('../../addon.js')

test('event name containing "Error" maps to Error type carrying rawError', function (t) {
  const err = new Error('generation failed')
  const result = mapAddonEvent('GenerationError', null, err)
  t.is(result.type, 'Error')
  t.is(result.error, err)
})

test('Uint8Array data maps to Output (image bytes)', function (t) {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const result = mapAddonEvent('ImageOutput', bytes, null)
  t.is(result.type, 'Output')
  t.is(result.data, bytes)
  t.is(result.error, null)
})

test('string data maps to Output (progress JSON tick)', function (t) {
  const tick = '{"step":3,"total":20,"elapsed_ms":1234}'
  const result = mapAddonEvent('Progress', tick, null)
  t.is(result.type, 'Output')
  t.is(result.data, tick)
})

test('plain object data maps to JobEnded (RuntimeStats)', function (t) {
  const stats = { total_time_ms: 5000, steps: 20 }
  const result = mapAddonEvent('Stats', stats, null)
  t.is(result.type, 'JobEnded')
  t.is(result.data, stats)
  t.is(result.error, null)
})

test('Error event takes precedence over data shape', function (t) {
  const err = new Error('boom')
  const bytes = new Uint8Array([1, 2, 3])
  const result = mapAddonEvent('FatalError', bytes, err)
  t.is(result.type, 'Error', 'Error event name beats Uint8Array output shape')
  t.is(result.error, err)
})

test('null data with unknown event returns null', function (t) {
  t.is(mapAddonEvent('Unknown', null, null), null)
})

test('number/boolean data with unknown event returns null', function (t) {
  t.is(mapAddonEvent('Unknown', 42, null), null)
  t.is(mapAddonEvent('Unknown', true, null), null)
})
