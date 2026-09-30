'use strict'

const test = require('brittle')
const {
  checkCoremlLane,
  resolveActiveBackend,
  COREML_BACKEND
} = require('../benchmark/coreml-lane.js')

const ON_COREML = { encoderOnCoreml: 1, encoderUsedCoreml: 1 }
const FELL_BACK = { encoderOnCoreml: 1, encoderUsedCoreml: 0 }
const ON_GGML = { encoderOnCoreml: 0, encoderUsedCoreml: 0 }
const NOT_REPORTED = { encoderOnCoreml: 1 }

test('coreml lane: passes when every measured run used Core ML', (t) => {
  const lane = checkCoremlLane({ runs: [ON_COREML, ON_COREML], expectCoreml: true })
  t.is(lane.failure, null)
  t.is(lane.allRunsOnCoreml, true)
  t.is(resolveActiveBackend({ ...lane, backendName: 'Metal' }), COREML_BACKEND)
})

test('coreml lane: fails when the sidecar loaded but one run fell back to ggml', (t) => {
  const lane = checkCoremlLane({ runs: [ON_COREML, FELL_BACK], expectCoreml: true })
  t.ok(lane.failure, 'a mixed lane must not publish a coreml artifact')
  t.ok(lane.failure.includes('1 of 2'), 'the failure counts the Core ML runs')
  t.is(lane.allRunsOnCoreml, false)
})

test('coreml lane: fails when runs do not report per-call routing', (t) => {
  const lane = checkCoremlLane({ runs: [NOT_REPORTED], expectCoreml: true })
  t.ok(lane.failure, 'a loaded sidecar alone is not proof the encoder ran on it')
})

test('coreml lane: fails when no run was measured', (t) => {
  const lane = checkCoremlLane({ runs: [], expectCoreml: true })
  t.ok(lane.failure)
  t.is(lane.allRunsOnCoreml, false)
})

test('non-coreml lane: passes when the encoder stayed on ggml', (t) => {
  const lane = checkCoremlLane({ runs: [ON_GGML, FELL_BACK], expectCoreml: false })
  t.is(lane.failure, null)
  t.is(resolveActiveBackend({ ...lane, backendName: 'Metal' }), 'Metal')
})

test('non-coreml lane: fails when any run used Core ML', (t) => {
  const lane = checkCoremlLane({ runs: [ON_GGML, ON_COREML], expectCoreml: false })
  t.ok(lane.failure, 'a stray sidecar must not publish Neural Engine numbers under a ggml label')
})
