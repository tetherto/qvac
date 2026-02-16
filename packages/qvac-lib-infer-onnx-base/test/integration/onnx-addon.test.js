'use strict'

const {
  OnnxSession,
  createSession,
  destroySession,
  getInputInfo,
  getOutputInfo,
  run,
  getCacheStats
} = require('../..')
const test = require('brittle')
const path = require('bare-path')

const MODELS_DIR = path.resolve('.', 'models')

test('OnnxSession class - create and get info', { timeout: 60 * 1000 }, async function (t) {
  const modelPath = path.join(MODELS_DIR, 'add_test.onnx')

  t.comment('Creating OnnxSession with model: ' + modelPath)
  const session = new OnnxSession(modelPath, { provider: 'cpu' })

  t.ok(session, 'session should be created')
  t.ok(session.nativeHandle, 'session should have native handle')

  // Get input info
  const inputs = session.getInputInfo()
  t.comment('Input info: ' + JSON.stringify(inputs))
  t.ok(Array.isArray(inputs), 'inputs should be an array')
  t.ok(inputs.length === 2, 'add model should have 2 inputs')
  t.ok(inputs[0].name === 'input_a', 'first input should be named input_a')
  t.ok(inputs[1].name === 'input_b', 'second input should be named input_b')

  // Get output info
  const outputs = session.getOutputInfo()
  t.comment('Output info: ' + JSON.stringify(outputs))
  t.ok(Array.isArray(outputs), 'outputs should be an array')
  t.ok(outputs.length === 1, 'add model should have 1 output')
  t.ok(outputs[0].name === 'output', 'output should be named output')

  session.dispose()
  t.pass('session disposed successfully')
})

test('OnnxSession class - run inference', { timeout: 60 * 1000 }, async function (t) {
  const modelPath = path.join(MODELS_DIR, 'add_test.onnx')
  const session = new OnnxSession(modelPath, { provider: 'cpu' })

  // Prepare input data: [1, 2, 3, 4] + [5, 6, 7, 8] = [6, 8, 10, 12]
  const inputA = new Float32Array([1.0, 2.0, 3.0, 4.0])
  const inputB = new Float32Array([5.0, 6.0, 7.0, 8.0])

  t.comment('Running inference...')
  const results = session.run([
    { name: 'input_a', shape: [1, 4], type: 'float32', data: inputA },
    { name: 'input_b', shape: [1, 4], type: 'float32', data: inputB }
  ])

  t.ok(Array.isArray(results), 'results should be an array')
  t.ok(results.length === 1, 'should have 1 output')
  t.ok(results[0].name === 'output', 'output name should match')

  const outputData = results[0].data
  t.ok(outputData instanceof Float32Array, 'output data should be Float32Array')
  t.ok(outputData.length === 4, 'output should have 4 elements')

  // Verify addition results
  t.comment('Output data: ' + JSON.stringify(Array.from(outputData)))
  t.ok(Math.abs(outputData[0] - 6.0) < 0.001, 'output[0] should be 6.0')
  t.ok(Math.abs(outputData[1] - 8.0) < 0.001, 'output[1] should be 8.0')
  t.ok(Math.abs(outputData[2] - 10.0) < 0.001, 'output[2] should be 10.0')
  t.ok(Math.abs(outputData[3] - 12.0) < 0.001, 'output[3] should be 12.0')

  session.dispose()
  t.pass('inference completed successfully')
})

test('Function API - createSession and run', { timeout: 60 * 1000 }, async function (t) {
  const modelPath = path.join(MODELS_DIR, 'multiply_test.onnx')

  t.comment('Creating session with function API: ' + modelPath)
  const handle = createSession(modelPath, { provider: 'cpu' })

  t.ok(handle, 'handle should be created')

  // Get input info
  const inputs = getInputInfo(handle)
  t.comment('Input info: ' + JSON.stringify(inputs))
  t.ok(inputs.length === 1, 'multiply model should have 1 input')
  t.ok(inputs[0].name === 'input', 'input should be named input')

  // Get output info
  const outputs = getOutputInfo(handle)
  t.ok(outputs.length === 1, 'multiply model should have 1 output')

  // Prepare input data (1x3x4x4 = 48 elements)
  const inputData = new Float32Array(48).fill(3.0)

  t.comment('Running inference...')
  const results = run(handle, [
    { name: 'input', shape: [1, 3, 4, 4], type: 'float32', data: inputData }
  ])

  t.ok(results.length === 1, 'should have 1 output')
  const outputData = results[0].data
  t.ok(outputData.length === 48, 'output should have 48 elements')

  // Verify multiplication by 2 (3.0 * 2.0 = 6.0)
  t.ok(Math.abs(outputData[0] - 6.0) < 0.001, 'output[0] should be 6.0')
  t.ok(Math.abs(outputData[47] - 6.0) < 0.001, 'output[47] should be 6.0')

  destroySession(handle)
  t.pass('function API test completed')
})

test('Session caching - same config reuses session', { timeout: 60 * 1000 }, async function (t) {
  const modelPath = path.join(MODELS_DIR, 'add_test.onnx')
  const config = { provider: 'cpu', optimization: 'basic' }

  t.comment('Creating first session...')
  const handle1 = createSession(modelPath, config)

  let stats = getCacheStats()
  t.comment('Cache stats after first session: ' + JSON.stringify(stats))
  const initialSessionCount = stats.sessionCount

  // Find the session in cache
  let cachedSession = stats.sessions.find(s => s.modelPath === modelPath)
  t.ok(cachedSession, 'session should be in cache')
  t.ok(cachedSession.refCount === 1, 'refCount should be 1')

  t.comment('Creating second session with same config...')
  const handle2 = createSession(modelPath, config)

  stats = getCacheStats()
  t.comment('Cache stats after second session: ' + JSON.stringify(stats))
  t.ok(stats.sessionCount === initialSessionCount, 'session count should not increase')

  cachedSession = stats.sessions.find(s => s.modelPath === modelPath)
  t.ok(cachedSession.refCount === 2, 'refCount should be 2')

  t.comment('Destroying first session...')
  destroySession(handle1)

  stats = getCacheStats()
  cachedSession = stats.sessions.find(s => s.modelPath === modelPath)
  t.comment('Cache stats after destroying first session: ' + JSON.stringify(stats))
  t.ok(cachedSession.refCount === 1, 'refCount should be 1 after destroying first')

  t.comment('Destroying second session...')
  destroySession(handle2)

  // After both destroyed, session should be removed from cache
  // (or refCount should be 0, depending on implementation)
  stats = getCacheStats()
  t.comment('Cache stats after destroying both sessions: ' + JSON.stringify(stats))

  t.pass('session caching test completed')
})

test('Session caching - different config creates new session', { timeout: 60 * 1000 }, async function (t) {
  const modelPath = path.join(MODELS_DIR, 'add_test.onnx')

  t.comment('Creating session with basic optimization...')
  const handle1 = createSession(modelPath, { provider: 'cpu', optimization: 'basic' })

  let stats = getCacheStats()
  const countAfterFirst = stats.sessionCount
  t.comment('Session count after first: ' + countAfterFirst)

  t.comment('Creating session with extended optimization...')
  const handle2 = createSession(modelPath, { provider: 'cpu', optimization: 'extended' })

  stats = getCacheStats()
  t.comment('Session count after second: ' + stats.sessionCount)
  t.ok(stats.sessionCount > countAfterFirst, 'different config should create new session')

  destroySession(handle1)
  destroySession(handle2)

  t.pass('different config caching test completed')
})

test('Multiple models can be loaded simultaneously', { timeout: 60 * 1000 }, async function (t) {
  const addModelPath = path.join(MODELS_DIR, 'add_test.onnx')
  const mulModelPath = path.join(MODELS_DIR, 'multiply_test.onnx')

  t.comment('Loading add model...')
  const addSession = new OnnxSession(addModelPath, { provider: 'cpu' })

  t.comment('Loading multiply model...')
  const mulSession = new OnnxSession(mulModelPath, { provider: 'cpu' })

  // Verify both work
  const addInputs = addSession.getInputInfo()
  const mulInputs = mulSession.getInputInfo()

  t.ok(addInputs.length === 2, 'add model should have 2 inputs')
  t.ok(mulInputs.length === 1, 'multiply model should have 1 input')

  // Run inference on both
  const addResult = addSession.run([
    { name: 'input_a', shape: [1, 4], type: 'float32', data: new Float32Array([1, 1, 1, 1]) },
    { name: 'input_b', shape: [1, 4], type: 'float32', data: new Float32Array([2, 2, 2, 2]) }
  ])

  const mulResult = mulSession.run([
    { name: 'input', shape: [1, 3, 4, 4], type: 'float32', data: new Float32Array(48).fill(5.0) }
  ])

  t.ok(Math.abs(addResult[0].data[0] - 3.0) < 0.001, 'add result should be 3')
  t.ok(Math.abs(mulResult[0].data[0] - 10.0) < 0.001, 'multiply result should be 10')

  addSession.dispose()
  mulSession.dispose()

  t.pass('multiple models test completed')
})

test('Error handling - invalid model path', { timeout: 30 * 1000 }, async function (t) {
  const invalidPath = '/nonexistent/model.onnx'

  try {
    createSession(invalidPath, { provider: 'cpu' })
    t.fail('should have thrown an error for invalid path')
  } catch (err) {
    t.ok(err, 'should throw error for invalid model path')
    t.comment('Error message: ' + err.message)
  }
})

test('getCacheStats returns valid structure', { timeout: 30 * 1000 }, async function (t) {
  const stats = getCacheStats()

  t.ok(typeof stats === 'object', 'stats should be an object')
  t.ok(typeof stats.sessionCount === 'number', 'sessionCount should be a number')
  t.ok(Array.isArray(stats.sessions), 'sessions should be an array')

  t.comment('Current cache stats: ' + JSON.stringify(stats))
  t.pass('getCacheStats structure is valid')
})
