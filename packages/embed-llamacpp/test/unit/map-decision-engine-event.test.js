'use strict'

const test = require('brittle')
const { mapDecisionEngineEvent } = require('../../decision.js')

test('DecisionEngineResult output is parsed from JSON', function (t) {
  const response = {
    model: 'tinyopenjev',
    answers: { refund: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 12, output_tokens: 0 }
  }
  const result = mapDecisionEngineEvent(
    '20DecisionEngineResult',
    JSON.stringify(response),
    undefined
  )
  t.is(result.type, 'Output')
  t.alike(result.data, response)
  t.is(result.error, null)
})

test('MSVC spelling of the output type name is recognized', function (t) {
  const result = mapDecisionEngineEvent('struct DecisionEngineResult', '{"answers":{}}', undefined)
  t.is(result.type, 'Output')
})

test('malformed output JSON throws', function (t) {
  t.exception.all(() => mapDecisionEngineEvent('20DecisionEngineResult', '{not json', undefined))
})

test('stats payload maps to JobEnded', function (t) {
  const result = mapDecisionEngineEvent(
    'Stats',
    { decision_input_tokens: 42, total_time_ms: 3.5 },
    null
  )
  t.is(result.type, 'JobEnded')
  t.is(result.data.decision_input_tokens, 42)
  t.is(result.data.total_time_ms, 3.5)
})

test('Error event name maps to Error type carrying rawError', function (t) {
  const err = new Error('boom')
  const result = mapDecisionEngineEvent(
    'N26qvac_lib_inference_addon_cpp6Output5ErrorE',
    undefined,
    err
  )
  t.is(result.type, 'Error')
  t.is(result.error, err)
})

test('Laya and embedding events are not DecisionEngine events', function (t) {
  t.is(mapDecisionEngineEvent('18LayaDecisionResult', '{"answers":{}}', undefined), null)
  t.is(mapDecisionEngineEvent('14BertEmbeddings', [[0.1]], undefined), null)
  t.is(mapDecisionEngineEvent('Stats', { forward_passes: 1 }, null), null)
})
