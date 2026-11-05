'use strict'

const test = require('brittle')
const { mapRerankEvent } = require('../../rerank.js')

test('RerankScores output becomes plain numbers', function (t) {
  const scores = new Float32Array([0.5, -1.25, 2])
  const result = mapRerankEvent('12RerankScores', scores, undefined)
  t.is(result.type, 'Output')
  t.ok(Array.isArray(result.data))
  t.alike(result.data, [0.5, -1.25, 2])
  t.is(result.error, null)
})

test('MSVC spelling of the output type name is recognized', function (t) {
  const result = mapRerankEvent('struct RerankScores', new Float32Array([1]), undefined)
  t.is(result.type, 'Output')
})

test('no documents give no scores', function (t) {
  const result = mapRerankEvent('12RerankScores', new Float32Array(0), undefined)
  t.is(result.type, 'Output')
  t.alike(result.data, [])
})

test('output without scores throws, for the caller to fail the job', function (t) {
  t.exception.all(() => mapRerankEvent('12RerankScores', null, undefined))
})

test('stats payload maps to JobEnded with backendDevice names', function (t) {
  const gpu = mapRerankEvent('Stats', { documents: 4, forward_passes: 1, backendDevice: 1 }, null)
  t.is(gpu.type, 'JobEnded')
  t.is(gpu.data.backendDevice, 'gpu')
  t.is(gpu.data.documents, 4)
  t.is(mapRerankEvent('Stats', { documents: 1, backendDevice: 0 }, null).data.backendDevice, 'cpu')
})

test('Error event name maps to Error type carrying rawError', function (t) {
  const err = new Error('boom')
  const result = mapRerankEvent('N26qvac_lib_inference_addon_cpp6Output5ErrorE', undefined, err)
  t.is(result.type, 'Error')
  t.is(result.error, err)
})

test('embedding and Laya events are not rerank events', function (t) {
  t.is(mapRerankEvent('14BertEmbeddings', [[0.1]], undefined), null)
  t.is(mapRerankEvent('18LayaDecisionResult', '{}', undefined), null)
  t.is(mapRerankEvent('Stats', { forward_passes: 1, sequences: 3 }, null), null)
})
