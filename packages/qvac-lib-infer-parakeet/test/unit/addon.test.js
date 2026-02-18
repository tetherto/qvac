'use strict'

const test = require('brittle')
const TranscriptionParakeet = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')
const MockedBinding = require('../mocks/MockedBinding.js')
const { transitionCb, wait } = require('../mocks/utils.js')
const { ParakeetInterface } = require('../../parakeet')

const process = require('process')
global.process = process
const sinon = require('sinon')

function createMockedModel ({ onOutput = () => { }, binding = undefined } = {}) {
  // Restore any existing stub first
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()
  // Mock validateModelFiles on the prototype BEFORE creating instance
  const validateStub = sinon.stub(TranscriptionParakeet.prototype, 'validateModelFiles').returns(undefined)

  const args = {
    modelName: 'parakeet-tdt-0.6b-v3-onnx',
    loader: new FakeDL({}),
    diskPath: './models'
  }
  const config = {
    parakeetConfig: {
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false
    }
  }
  const model = new TranscriptionParakeet(args, config)

  sinon.stub(model, '_createAddon').callsFake(configurationParams => {
    const _binding = binding || new MockedBinding()
    const addon = new ParakeetInterface(_binding, configurationParams, onOutput, transitionCb)

    // Set the BaseInference callback on the mocked binding so _finishPromise gets resolved
    if (_binding.setBaseInferenceCallback) {
      _binding.setBaseInferenceCallback(model._outputCallback.bind(model))
    }

    return addon
  })

  // Store stub reference for cleanup
  model._validateStub = validateStub

  return model
}

/**
 * Test that the inference process returns the expected output.
 */
test('Inference returns correct output for audio input', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const model = createMockedModel({ onOutput })
  await model.load()

  // Simulate sending an audio chunk (Float32Array buffer)
  const sampleAudio = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5])
  const jobId1 = await model.addon.append({ type: 'audio', data: sampleAudio.buffer })
  t.is(jobId1, 1, 'First job ID should be 1')

  // Append an end-of-job marker.
  const jobIdEnd = await model.addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'Job ID should remain 1 for end-of-job signal')

  await wait()

  // Check that we received an Output event for the audio chunk.
  const outputEvent = events.find(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvent, 'Should receive an Output event for the audio chunk')
  t.ok(outputEvent.output, 'Output event should have output property')
  t.ok(Array.isArray(outputEvent.output), 'Output should be an array of segments')

  // Check that we received a JobEnded event.
  const jobEndedEvent = events.find(e => e.event === 'JobEnded' && e.jobId === 1)
  t.ok(jobEndedEvent, 'Should receive a JobEnded event for job 1')
})

/**
 * Test that the model correctly handles state transitions.
 */
test('Model state transitions are handled correctly', async (t) => {
  const model = createMockedModel()

  await model.load()

  const sampleAudio = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5])
  const response = await model.run(sampleAudio)
  await response._finishPromise

  t.ok(await model.status() === 'listening', 'Status: Model should be listening')

  await model.pause()
  t.ok(await model.status() === 'paused', 'Status: Model should be paused')

  await model.unpause()
  t.ok(await model.status() === 'listening', 'Status: Model should be listening')

  await model.addon.activate()
  t.ok(await model.status() === 'listening', 'Status: Model should be listening')

  // After destroy, the instance is invalid - we verify via transition callback
  await model.addon.destroyInstance()
  // Note: status() cannot be called after destroyInstance() as the handle is invalidated
})

/**
 * Test that errors during processing are properly emitted and caught.
 */
test('Model emits error events when an error occurs during processing', async (t) => {
  // Create a custom binding that throws an error on append
  const binding = {
    createInstance: () => ({ id: 1 }),
    append: () => { throw new Error('Forced error for testing') },
    loadWeights: () => { },
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
    await model.run('trigger error')
    t.fail('Should have thrown an error')
  } catch (error) {
    // The error should be a QvacErrorAddonParakeet
    t.ok(error.constructor.name === 'QvacErrorAddonParakeet', 'Error should be a QvacErrorAddonParakeet')
    t.ok(error.message.includes('Forced error') || typeof error.code === 'number', 'Error should contain forced error message or have error code')
  }
})

/**
 * Test that the FakeDL loader returns the correct file list and data streams.
 */
test('FakeDL returns correct file list and data streams', async (t) => {
  const fakeDL = new FakeDL({})

  const fileList = await fakeDL.list('/')
  t.ok(
    ['encoder-model.onnx', 'decoder_joint-model.onnx', 'vocab.txt', 'preprocessor.onnx'].every(f => fileList.includes(f)),
    'File list should match expected Parakeet model files'
  )

  for (const file of fileList) {
    const stream = await fakeDL.getStream(file)
    let data = ''
    for await (const chunk of stream) {
      data += chunk.toString()
    }
    t.ok(data.length > 0, `Stream for ${file} should contain data`)
  }
})

/**
 * Test the complete sequence of operations for the ParakeetInterface.
 */
test('ParakeetInterface full sequence: status, append, and job boundaries', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt',
    maxThreads: 4,
    useGPU: false
  }, onOutput, transitionCb)

  let status = await addon.status()
  t.ok(status === 'loading', 'Initial addon status should be "loading"')

  await addon.loadWeights({ filename: 'encoder-model.onnx', chunk: new Uint8Array([1, 2, 3]), completed: true })

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be "listening" after activation')

  // Append an audio chunk and verify the returned job ID.
  const audioData = new Float32Array([0.1, 0.2, 0.3]).buffer
  const appendResult1 = await addon.append({ type: 'audio', data: audioData })
  t.ok(appendResult1 === 1, 'Job ID should be 1 for the first appended chunk')

  await wait()
  const outputEvent = events.find(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvent, 'Output callback should be triggered for audio chunk')

  const appendResult2 = await addon.append({ type: 'end of job' })
  t.ok(appendResult2 === 1, 'Job ID should remain 1 for the end-of-job signal')

  await wait()
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 1),
    'JobEnded callback should be emitted for job 1'
  )

  status = await addon.status()
  t.ok(status === 'listening', 'Status should remain "listening" after job end')

  // Append another audio chunk, which should start a new job.
  const audioData2 = new Float32Array([0.4, 0.5]).buffer
  const appendResult3 = await addon.append({ type: 'audio', data: audioData2 })
  t.ok(appendResult3 === 2, 'Job ID should increment to 2 for a new job')

  await wait()

  // Append end-of-job signal for job 2.
  const appendResult4 = await addon.append({ type: 'end of job' })
  t.ok(appendResult4 === 2, 'Job ID should be 2 for the end-of-job signal of job 2')

  await wait()
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 2),
    'JobEnded callback should be emitted for job 2'
  )

  t.end()
})
