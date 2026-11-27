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

test('events of other output types are not DecisionEngine events', function (t) {
  t.is(mapDecisionEngineEvent('18LayaDecisionResult', '{"answers":{}}', undefined), null)
  t.is(mapDecisionEngineEvent('14BertEmbeddings', [[0.1]], undefined), null)
  t.is(mapDecisionEngineEvent('Stats', { forward_passes: 1 }, null), null)
})

test('an invalid-request run error gets a code and loses the marker', function (t) {
  const native = new Error('predict: invalid request: questions.q: too many options')
  const result = mapDecisionEngineEvent('Error', undefined, native)
  t.is(result.type, 'Error')
  t.is(result.error.code, 'DECISION_INVALID_REQUEST')
  t.is(result.error.message, 'questions.q: too many options')
})

test('other run errors pass through unchanged', function (t) {
  const failed = new Error('predict: the decision handler returned no answers')
  t.is(mapDecisionEngineEvent('Error', undefined, failed).error, failed)
  const cancelled = new Error('Job cancelled')
  t.is(mapDecisionEngineEvent('Error', undefined, cancelled).error, cancelled)
})

test('DecisionEngineInterface.runJob resolves a boolean, whatever admission returns', async function (t) {
  const { DecisionEngineInterface } = require('../../decision.js')
  let next
  const binding = {
    createInstance: () => ({ handle: true }),
    runJob: () => Promise.resolve(next)
  }
  const engine = new DecisionEngineInterface(binding, { path: '/m.gguf', config: {} }, () => {})
  for (const [admitted, expected] of [
    [7, true],
    [1, true],
    [true, true],
    [false, false],
    [0, false]
  ]) {
    next = admitted
    t.is(await engine.runJob('{}'), expected, `admission ${admitted} -> ${expected}`)
  }
})
