'use strict'

const test = require('brittle')
const { mapLayaEvent } = require('../../laya.js')

test('LayaDecisionResult output is parsed from JSON', function (t) {
  const response = {
    model: 'laya-rl-agent',
    answers: { refund: { type: 'noul', noul: 0.9 } },
    usage: {}
  }
  const result = mapLayaEvent('18LayaDecisionResult', JSON.stringify(response), undefined)
  t.is(result.type, 'Output')
  t.alike(result.data, response)
  t.is(result.error, null)
})

test('MSVC spelling of the output type name is recognized', function (t) {
  const result = mapLayaEvent('struct LayaDecisionResult', '{"answers":{}}', undefined)
  t.is(result.type, 'Output')
})

test('batch output stays a list, one result per state', function (t) {
  const result = mapLayaEvent('18LayaDecisionResult', '[{"answers":{}},{"answers":{}}]', undefined)
  t.is(result.type, 'Output')
  t.is(result.data.length, 2)
})

test('malformed output JSON throws', function (t) {
  t.exception.all(() => mapLayaEvent('18LayaDecisionResult', '{not json', undefined))
})

test('stats payload maps to JobEnded with backendDevice names', function (t) {
  const gpu = mapLayaEvent('Stats', { forward_passes: 1, total_tokens: 10, backendDevice: 1 }, null)
  t.is(gpu.type, 'JobEnded')
  t.is(gpu.data.backendDevice, 'gpu')
  t.is(gpu.data.forward_passes, 1)
  t.is(
    mapLayaEvent('Stats', { forward_passes: 1, backendDevice: 0 }, null).data.backendDevice,
    'cpu'
  )
})

test('Error event name maps to Error type carrying rawError', function (t) {
  const err = new Error('boom')
  const result = mapLayaEvent('N26qvac_lib_inference_addon_cpp6Output5ErrorE', undefined, err)
  t.is(result.type, 'Error')
  t.is(result.error, err)
})

test('embedding events are not Laya events', function (t) {
  t.is(mapLayaEvent('14BertEmbeddings', [[0.1]], undefined), null)
  t.is(mapLayaEvent('Unknown', { total_tokens: 1 }, null), null)
})
