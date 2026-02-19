'use strict'

const test = require('brittle')
const ONNXTTS = require('../../index.js')
const MockedBinding = require('../mock/MockedBinding.js')
const { transitionCb, wait } = require('../mock/utils.js')

const process = require('process')
global.process = process
const sinon = require('sinon')

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

function createMockedSupertonicModel ({ onOutput = () => { }, binding = undefined } = {}) {
  const args = {
    modelDir: './models/supertonic',
    voiceName: 'F1',
    speed: 1,
    numInferenceSteps: 5
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

const SUPERTONIC_ADDON_CONFIG = {
  modelDir: './models/supertonic',
  tokenizerPath: './tokenizer.json',
  textEncoderPath: './onnx/text_encoder.onnx',
  latentDenoiserPath: './onnx/latent_denoiser.onnx',
  voiceDecoderPath: './onnx/voice_decoder.onnx',
  voicesDir: './voices',
  voiceName: 'F1',
  language: 'en'
}

test('Supertonic: Inference returns correct output for text input', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const model = createMockedSupertonicModel({ onOutput })
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

test('Supertonic: Model state transitions are handled correctly', async (t) => {
  const model = createMockedSupertonicModel()
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

test('Supertonic: Model emits error events when an error occurs during processing', async (t) => {
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
  const model = createMockedSupertonicModel({ binding })
  await model.load()

  try {
    await model.run({ type: 'text', input: 'trigger error' })
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error, 'Error should be thrown')
    t.ok(error.message.includes('Forced error') || typeof error.code === 'number', 'Error should contain forced error message or have error code')
  }
})

test('Supertonic: TTSInterface full sequence: status, append, and job boundaries', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG,
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

test('Supertonic: append throws TypeError for invalid input', async (t) => {
  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG
  }, () => {}, transitionCb)

  await addon.activate()

  try {
    await addon.append({ input: 'Hello' })
    t.fail('Should throw TypeError for missing type')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
    t.ok(error.message.includes('expects an object with input and type properties'), 'Error message should mention required properties')
  }

  try {
    await addon.append({ type: 'text' })
    t.fail('Should throw TypeError for missing input')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
  }

  try {
    await addon.append('invalid')
    t.fail('Should throw TypeError for non-object input')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
  }

  try {
    await addon.append(null)
    t.fail('Should throw TypeError for null input')
  } catch (error) {
    t.ok(error instanceof TypeError, 'Should throw TypeError')
  }
})

test('Supertonic: Stop functionality stops processing', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG
  }, onOutput, transitionCb)

  await addon.activate()
  let status = await addon.status()
  t.ok(status === 'listening', 'Status should be listening after activation')

  await addon.stop()
  status = await addon.status()
  t.ok(status === 'stopped', 'Status should be stopped after stop()')
})

test('Supertonic: Cancel cancels specific job', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG
  }, onOutput, transitionCb)

  await addon.activate()

  const jobId = await addon.append({ type: 'text', input: 'Hello world' })
  t.is(jobId, 1, 'Job ID should be 1')

  await addon.cancel(jobId)
  const status = await addon.status()
  t.ok(status === 'stopped', 'Status should be stopped after cancel')
})

test('Supertonic: Unload destroys the addon instance', async (t) => {
  const model = createMockedSupertonicModel()
  await model.load()

  t.ok(model.addon, 'Addon should be created after load')

  await model.unload()

  const status = await model.status()
  t.ok(status === 'idle', 'Status should be idle after unload')
})

test('Supertonic: Reload reloads configuration', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG
  }, onOutput, transitionCb)

  await addon.activate()
  let status = await addon.status()
  t.ok(status === 'listening', 'Initial status should be listening')

  await addon.append({ type: 'text', input: 'Hello' })
  await addon.append({ type: 'end of job' })
  await wait()

  const initialEvents = events.filter(e => e.event === 'Output' && e.jobId === 1)
  t.ok(initialEvents.length > 0, 'Should receive Output events before reload')

  const newConfig = {
    ...SUPERTONIC_ADDON_CONFIG,
    language: 'es'
  }

  await addon.reload(newConfig)
  await wait()

  status = await addon.status()
  t.ok(status === 'idle' || status === 'loading', 'Status should be idle or loading after reload')

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be listening after activation')

  const jobId = await addon.append({ type: 'text', input: 'World' })
  t.is(jobId, 2, 'Job ID should increment to 2 after reload')

  await addon.append({ type: 'end of job' })
  await wait()

  const reloadEvents = events.filter(e => e.event === 'Output' && e.jobId === 2)
  t.ok(reloadEvents.length > 0, 'Should receive Output events after reload')
})

test('Supertonic: Append in invalid state emits error', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG
  }, onOutput, transitionCb)

  await addon.activate()

  await addon.stop()
  const status = await addon.status()
  t.ok(status === 'stopped', 'Status should be stopped')

  await addon.append({ type: 'text', input: 'Hello' })
  await wait()

  const errorEvent = events.find(e => e.event === 'Error')
  t.ok(errorEvent, 'Should receive an Error event when appending in invalid state')
  t.ok(errorEvent.output.error.includes('Invalid state'), 'Error should mention invalid state')
})

test('Supertonic: Append with unknown type emits error', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG
  }, onOutput, transitionCb)

  await addon.activate()

  await addon.append({ type: 'unknown_type', input: 'Hello' })
  await wait()

  const errorEvent = events.find(e => e.event === 'Error')
  t.ok(errorEvent, 'Should receive an Error event for unknown type')
  t.ok(errorEvent.output.error.includes('Unknown type'), 'Error should mention unknown type')
})

test('Supertonic: Static methods return expected values', async (t) => {
  const modelKey = ONNXTTS.getModelKey({})
  t.is(modelKey, 'onnx-tts', 'getModelKey should return "onnx-tts"')

  t.ok(ONNXTTS.inferenceManagerConfig, 'inferenceManagerConfig should exist')
  t.is(ONNXTTS.inferenceManagerConfig.noAdditionalDownload, true, 'noAdditionalDownload should be true')
})

test('Supertonic: Multiple text chunks in same job', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new MockedTTSInterface(binding, {
    ...SUPERTONIC_ADDON_CONFIG
  }, onOutput, transitionCb)

  await addon.activate()

  const jobId1 = await addon.append({ type: 'text', input: 'Hello' })
  t.is(jobId1, 1, 'First chunk job ID should be 1')

  await wait()

  const jobId2 = await addon.append({ type: 'text', input: 'World' })
  t.is(jobId2, 1, 'Second chunk job ID should still be 1 (same job)')

  await wait()

  const jobIdEnd = await addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'End of job ID should be 1')

  await wait()

  const outputEvents = events.filter(e => e.event === 'Output' && e.jobId === 1)
  t.is(outputEvents.length, 2, 'Should receive 2 Output events for 2 text chunks')

  const jobEndedEvent = events.find(e => e.event === 'JobEnded' && e.jobId === 1)
  t.ok(jobEndedEvent, 'Should receive JobEnded event for job 1')
})

test('Supertonic: Engine type is detected correctly', async (t) => {
  const supertonicModelDirArgs = {
    modelDir: './models/supertonic',
    voiceName: 'F1'
  }
  const modelFromDir = new ONNXTTS(supertonicModelDirArgs, {})
  t.is(modelFromDir._engineType, 'supertonic', 'Should detect Supertonic engine when modelDir + voiceName are provided')

  const supertonicExplicitArgs = {
    textEncoderPath: './onnx/text_encoder.onnx',
    latentDenoiserPath: './onnx/latent_denoiser.onnx',
    voiceDecoderPath: './onnx/voice_decoder.onnx'
  }
  const modelFromPaths = new ONNXTTS(supertonicExplicitArgs, {})
  t.is(modelFromPaths._engineType, 'supertonic', 'Should detect Supertonic engine when textEncoderPath is provided')
})
