'use strict'

const test = require('brittle')
const ONNXTTS = require('../../index.js')
const MockedBinding = require('../mock/MockedBinding.js')
const { transitionCb, wait } = require('../mock/utils.js')

const process = require('process')
global.process = process
const sinon = require('sinon')

/**
 * TTSInterface wrapper that uses MockedBinding for testing
 */
class MockedTTSInterface {
  constructor (binding, configuration, outputCb, transitionCb = null) {
    this._binding = binding
    this._handle = binding.createInstance(this, configuration, outputCb, transitionCb)
  }

  async activate () {
    this._binding.activate(this._handle)
  }

  async append (data) {
    if (typeof data !== 'object' || !data.type || (!data.input && data.type !== 'end of job')) {
      throw new TypeError('append(data) expects an object with input and type properties')
    }
    return this._binding.append(this._handle, data)
  }

  async status () {
    return this._binding.status(this._handle)
  }

  async pause () {
    return this._binding.pause(this._handle)
  }

  async stop () {
    return this._binding.stop(this._handle)
  }

  async cancel (jobId) {
    this._binding.cancel(this._handle, jobId)
  }

  async load (configurationParams) {
    this._binding.load(this._handle, configurationParams)
  }

  async reload (configurationParams) {
    this._binding.reload(this._handle, configurationParams)
  }

  async unload () {
    this._binding.unload(this._handle)
  }

  async destroyInstance () {
    const h = this._handle
    this._handle = null
    return this._binding.destroyInstance(h)
  }
}

function createMockedModel ({ onOutput = () => { }, binding = undefined } = {}) {
  const args = {
    mainModelUrl: './models/tts/model.onnx',
    configJsonPath: './models/tts/config.json',
    eSpeakDataPath: './models/tts/espeak-ng-data'
    // No loader - _downloadWeights will skip
  }
  const config = {
    language: 'en',
    useGPU: false
  }
  const model = new ONNXTTS(args, config)

  sinon.stub(model, '_createAddon').callsFake((configurationParams, outputCb, logger) => {
    const _binding = binding || new MockedBinding()
    const addon = new MockedTTSInterface(_binding, configurationParams, onOutput, transitionCb)

    if (_binding.setBaseInferenceCallback) {
      _binding.setBaseInferenceCallback(model._outputCallback.bind(model))
    }

    return addon
  })
  return model
}

/**
 * Test that the inference process returns the expected output.
 */
test('Inference returns correct output for text input', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const model = createMockedModel({ onOutput })
  await model.load()

  const sampleText = 'Hello world'
  const jobId1 = await model.addon.append({ type: 'text', input: sampleText })
  t.is(jobId1, 1, 'First job ID should be 1')

  const jobIdEnd = await model.addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'Job ID should remain 1 for end-of-job signal')

  await wait()

  const outputEvent = events.find(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvent, 'Should receive an Output event for the text chunk')
  t.ok(outputEvent.output.outputArray, 'Output should contain outputArray (audio samples)')
  t.ok(outputEvent.output.outputArray.length > 0, 'Output array should have samples')

  const jobEndedEvent = events.find(e => e.event === 'JobEnded' && e.jobId === 1)
  t.ok(jobEndedEvent, 'Should receive a JobEnded event for job 1')
})

/**
 * Test that the model correctly handles state transitions.
 */
test('Model state transitions are handled correctly', async (t) => {
  const model = createMockedModel()
  await model.load()

  const response = await model.run({ type: 'text', input: 'Test message' })
  await response._finishPromise

  t.ok(await model.status() === 'listening', 'Status: Model should be listening')

  await model.pause()
  t.ok(await model.status() === 'paused', 'Status: Model should be paused')

  await model.addon.activate()
  t.ok(await model.status() === 'listening', 'Status: Model should be listening after reactivation')

  await model.addon.destroyInstance()
  t.ok(await model.status() === 'idle', 'Status: Model should be idle after destroy')
})

/**
 * Test that errors during processing are properly emitted and caught.
 */
test('Model emits error events when an error occurs during processing', async (t) => {
  const binding = {
    createInstance: () => ({ id: 1 }),
    append: () => { throw new Error('Forced error for testing') },
    activate: () => { },
    pause: () => { },
    stop: () => { },
    cancel: () => { },
    status: () => 'idle',
    destroyInstance: () => { }
  }
  const model = createMockedModel({ binding })
  await model.load()

  try {
    await model.run({ type: 'text', input: 'trigger error' })
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error, 'Error should be thrown')
    t.ok(error.message.includes('Forced error') || typeof error.code === 'number', 'Error should contain forced error message or have error code')
  }
})

/**
 * Test the complete sequence of operations for the TTSInterface.
 */
test('TTSInterface full sequence: status, append, and job boundaries', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en',
    useGPU: false
  }, onOutput, transitionCb)

  let status = await addon.status()
  t.ok(status === 'loading', 'Initial addon status should be "loading"')

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be "listening" after activation')

  const appendResult1 = await addon.append({ type: 'text', input: 'Hello' })
  t.ok(appendResult1 === 1, 'Job ID should be 1 for the first appended chunk')

  await wait()
  const outputEvent1 = events.find(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvent1, 'Output callback should be triggered for text input')
  t.ok(outputEvent1.output.outputArray, 'Output should contain audio samples')

  const appendResult2 = await addon.append({ type: 'end of job' })
  t.ok(appendResult2 === 1, 'Job ID should remain 1 for the end-of-job signal')

  await wait()
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 1 && e.output.type === 'end of job'),
    'JobEnded callback should be emitted for job 1'
  )

  status = await addon.status()
  t.ok(status === 'listening', 'Status should remain "listening" after job end')

  const appendResult3 = await addon.append({ type: 'text', input: 'World' })
  t.ok(appendResult3 === 2, 'Job ID should increment to 2 for a new job')
  await wait()
  t.ok(
    events.find(e => e.event === 'Output' && e.jobId === 2),
    'Output callback should be triggered for job 2'
  )

  const appendResult4 = await addon.append({ type: 'end of job' })
  t.ok(appendResult4 === 2, 'Job ID should be 2 for the end-of-job signal of job 2')
  await wait()
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 2),
    'JobEnded callback should be emitted for job 2'
  )

  t.end()
})

/**
 * Test that append throws TypeError for invalid input.
 */
test('append throws TypeError for invalid input', async (t) => {
  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en'
  }, () => {}, transitionCb)

  await addon.activate()

  // Test with missing type
  try {
    await addon.append({ input: 'Hello' })
    t.fail('Should throw TypeError for missing type')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
    t.ok(error.message.includes('expects an object with input and type properties'), 'Error message should mention required properties')
  }

  // Test with missing input (non end-of-job)
  try {
    await addon.append({ type: 'text' })
    t.fail('Should throw TypeError for missing input')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
  }

  // Test with non-object input
  try {
    await addon.append('invalid')
    t.fail('Should throw TypeError for non-object input')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
  }

  // Test with null
  try {
    await addon.append(null)
    t.fail('Should throw TypeError for null input')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
  }
})

/**
 * Test stop functionality.
 */
test('Stop functionality stops processing', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en'
  }, onOutput, transitionCb)

  await addon.activate()
  let status = await addon.status()
  t.ok(status === 'listening', 'Status should be listening after activation')

  // Stop the addon
  await addon.stop()
  status = await addon.status()
  t.ok(status === 'stopped', 'Status should be stopped after stop()')
})

/**
 * Test cancel functionality.
 */
test('Cancel cancels specific job', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en'
  }, onOutput, transitionCb)

  await addon.activate()

  // Start a job
  const jobId = await addon.append({ type: 'text', input: 'Hello world' })
  t.is(jobId, 1, 'Job ID should be 1')

  // Cancel the job
  await addon.cancel(jobId)
  const status = await addon.status()
  t.ok(status === 'stopped', 'Status should be stopped after cancel')
})

/**
 * Test unload functionality.
 */
test('Unload destroys the addon instance', async (t) => {
  const model = createMockedModel()
  await model.load()

  // Verify addon is loaded
  t.ok(model.addon, 'Addon should be created after load')

  // Unload the model
  await model.unload()

  // Status should be idle after destroy
  const status = await model.status()
  t.ok(status === 'idle', 'Status should be idle after unload')
})

/**
 * Test reload functionality.
 */
test('Reload reloads configuration', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en'
  }, onOutput, transitionCb)

  await addon.activate()
  let status = await addon.status()
  t.ok(status === 'listening', 'Initial status should be listening')

  // Process text before reload
  await addon.append({ type: 'text', input: 'Hello' })
  await addon.append({ type: 'end of job' })
  await wait()

  const initialEvents = events.filter(e => e.event === 'Output' && e.jobId === 1)
  t.ok(initialEvents.length > 0, 'Should receive Output events before reload')

  // Reload with new configuration
  const newConfig = {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'es'
  }

  await addon.reload(newConfig)
  await wait()

  status = await addon.status()
  t.ok(status === 'idle' || status === 'loading', 'Status should be idle or loading after reload')

  // Activate after reload
  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be listening after activation')

  // Process text after reload
  const jobId = await addon.append({ type: 'text', input: 'World' })
  t.is(jobId, 2, 'Job ID should increment to 2 after reload')

  await addon.append({ type: 'end of job' })
  await wait()

  const reloadEvents = events.filter(e => e.event === 'Output' && e.jobId === 2)
  t.ok(reloadEvents.length > 0, 'Should receive Output events after reload')
})

/**
 * Test append in invalid state emits error.
 */
test('Append in invalid state emits error', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en'
  }, onOutput, transitionCb)

  await addon.activate()

  // Stop the addon first
  await addon.stop()
  const status = await addon.status()
  t.ok(status === 'stopped', 'Status should be stopped')

  // Try to append when stopped - should emit error
  await addon.append({ type: 'text', input: 'Hello' })
  await wait()

  const errorEvent = events.find(e => e.event === 'Error')
  t.ok(errorEvent, 'Should receive an Error event when appending in invalid state')
  t.ok(errorEvent.output.error.includes('Invalid state'), 'Error should mention invalid state')
})

/**
 * Test append with unknown type emits error.
 */
test('Append with unknown type emits error', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en'
  }, onOutput, transitionCb)

  await addon.activate()

  // Append with unknown type
  await addon.append({ type: 'unknown_type', input: 'Hello' })
  await wait()

  const errorEvent = events.find(e => e.event === 'Error')
  t.ok(errorEvent, 'Should receive an Error event for unknown type')
  t.ok(errorEvent.output.error.includes('Unknown type'), 'Error should mention unknown type')
})

/**
 * Test static methods return expected values.
 */
test('Static methods return expected values', async (t) => {
  // Test getModelKey
  const modelKey = ONNXTTS.getModelKey({})
  t.is(modelKey, 'onnx-tts', 'getModelKey should return "onnx-tts"')

  // Test inferenceManagerConfig
  t.ok(ONNXTTS.inferenceManagerConfig, 'inferenceManagerConfig should exist')
  t.is(ONNXTTS.inferenceManagerConfig.noAdditionalDownload, true, 'noAdditionalDownload should be true')
})

/**
 * Test multiple text chunks in same job.
 */
test('Multiple text chunks in same job', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    modelPath: './model.onnx',
    configJsonPath: './config.json',
    eSpeakDataPath: './espeak-ng-data',
    language: 'en'
  }, onOutput, transitionCb)

  await addon.activate()

  // Append multiple text chunks before end of job
  const jobId1 = await addon.append({ type: 'text', input: 'Hello' })
  t.is(jobId1, 1, 'First chunk job ID should be 1')

  await wait()

  const jobId2 = await addon.append({ type: 'text', input: 'World' })
  t.is(jobId2, 1, 'Second chunk job ID should still be 1 (same job)')

  await wait()

  // End the job
  const jobIdEnd = await addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'End of job ID should be 1')

  await wait()

  // Should have multiple output events for the same job
  const outputEvents = events.filter(e => e.event === 'Output' && e.jobId === 1)
  t.is(outputEvents.length, 2, 'Should receive 2 Output events for 2 text chunks')

  // Should have one JobEnded event
  const jobEndedEvent = events.find(e => e.event === 'JobEnded' && e.jobId === 1)
  t.ok(jobEndedEvent, 'Should receive JobEnded event for job 1')
})
