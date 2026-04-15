'use strict'

const test = require('brittle')
const TranscriptionParakeet = require('../../index.js')
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

  const model = new TranscriptionParakeet({
    files: {},
    config: {
      parakeetConfig: {
        modelType: 'tdt',
        maxThreads: 4,
        useGPU: false
      }
    }
  })

  sinon.stub(model, '_createAddon').callsFake(configurationParams => {
    const _binding = binding || new MockedBinding()
    const addon = new ParakeetInterface(_binding, configurationParams, (addon, event, jobId, output, error) => {
      model._outputCallback(addon, event, jobId, output, error)
      onOutput(addon, event, jobId, output, error)
    }, transitionCb)

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
    runJob: () => { throw new Error('Forced error for testing') },
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
    const response = await model.run('trigger error')
    await response.await()
    t.fail('Should have rejected the response')
  } catch (error) {
    // The error should be a QvacErrorAddonParakeet
    t.ok(error.constructor.name === 'QvacErrorAddonParakeet', 'Error should be a QvacErrorAddonParakeet')
    t.ok(error.message.includes('Forced error') || typeof error.code === 'number', 'Error should contain forced error message or have error code')
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

  const appendResult2 = await addon.append({ type: 'end of job' })
  t.ok(appendResult2 === 1, 'Job ID should remain 1 for the end-of-job signal')

  await wait()
  const outputEvent = events.find(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvent, 'Output callback should be triggered for audio chunk')
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

test('ParakeetInterface runJob preserves active job when native rejects new job', async (t) => {
  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, () => {})

  addon._activeJobId = 42
  addon._nextJobId = 43
  addon._setState('processing')
  binding.runJob = () => false

  const accepted = await addon.runJob({
    type: 'audio',
    input: new Float32Array([0.1, 0.2, 0.3])
  })

  t.is(accepted, false, 'runJob should report rejected when native side is busy')
  t.is(addon._activeJobId, 42, 'Current active job ID should remain unchanged')
  t.is(addon._nextJobId, 43, 'Next job counter should not advance on rejection')
  t.is(await addon.status(), 'processing', 'State should remain unchanged for the current active job')
})

test('ParakeetInterface cancel clears active job only after cancel resolves', async (t) => {
  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, () => {})

  addon._activeJobId = 7
  addon._setState('processing')
  let sawActiveJobDuringCancel = false

  binding.cancel = async (handle) => {
    t.is(handle, addon._handle, 'cancel should be called with current handle')
    sawActiveJobDuringCancel = addon._activeJobId === 7
    await wait(5)
    addon._addonOutputCallback(addon, 'Error', null, 'Job cancelled')
  }

  await addon.cancel(7)

  t.ok(sawActiveJobDuringCancel, 'Active job should still be set while cancel is in-flight')
  t.is(addon._activeJobId, null, 'Active job should be cleared after cancel resolves')
  t.is(await addon.status(), 'listening', 'State should return to listening after cancel resolves')
})

test('ParakeetInterface cancels buffered job before native run starts', async (t) => {
  const events = []
  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, (handle, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  })

  const pendingJobId = await addon.append({
    type: 'audio',
    data: new Float32Array([0.1, 0.2, 0.3]).buffer
  })

  await addon.cancel(pendingJobId)

  t.is(addon._activeJobId, null, 'Buffered cancel should not leave an active native job')
  t.is(addon._bufferedAudio.length, 0, 'Buffered cancel should clear queued audio')
  t.is(await addon.status(), 'listening', 'Buffered cancel should return to listening state')
  t.ok(
    events.find(e => e.event === 'Error' && e.jobId === pendingJobId && e.error === 'Job cancelled'),
    'Buffered cancel should fail the pending JS-owned job'
  )
})

test('ParakeetInterface ignores stale wrapper job ids when cancelling', async (t) => {
  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, () => {})

  addon._activeJobId = 2
  addon._nextJobId = 3
  addon._setState('processing')

  let cancelCalls = 0
  binding.cancel = async () => {
    cancelCalls += 1
  }

  await addon.cancel(1)

  t.is(cancelCalls, 0, 'Stale response ids should not cancel the current native job')
  t.is(addon._activeJobId, 2, 'Stale response ids should leave the active job unchanged')
  t.is(await addon.status(), 'processing', 'Stale response ids should not change state')
})

test('ParakeetInterface unloadWeights throws unsupported operation error', async (t) => {
  const addon = new ParakeetInterface(new MockedBinding(), {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, () => {})

  let threw = false
  try {
    await addon.unloadWeights()
  } catch (error) {
    threw = true
    t.is(error.code, 24007, 'unloadWeights should map to FAILED_TO_RESET')
    t.ok(String(error.message).includes('unloadWeights is not supported'), 'Error should explain supported alternatives')
  }
  t.ok(threw, 'unloadWeights should throw')
})

test('ParakeetInterface destroyInstance awaits active cancel before teardown', async (t) => {
  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, () => {})

  addon._activeJobId = 9
  addon._setState('processing')

  let cancelResolved = false
  let destroySawResolvedCancel = false

  const originalDestroy = binding.destroyInstance.bind(binding)
  binding.cancel = async (handle) => {
    t.is(handle, addon._handle, 'cancel should receive current handle')
    await wait(5)
    cancelResolved = true
  }
  binding.destroyInstance = (handle) => {
    destroySawResolvedCancel = cancelResolved
    originalDestroy(handle)
  }

  await addon.destroyInstance()

  t.ok(destroySawResolvedCancel, 'destroy should run only after cancel promise resolves')
  t.is(addon._handle, null, 'handle should be cleared after destroy')
  t.is(addon._activeJobId, null, 'active job should be cleared after destroy')
  t.is(await addon.status(), 'idle', 'state should transition to idle after destroy')
})

test('ParakeetInterface destroyInstance skips cancel with no active job', async (t) => {
  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, () => {})

  let cancelCalls = 0
  binding.cancel = async () => {
    cancelCalls += 1
  }

  await addon.destroyInstance()

  t.is(cancelCalls, 0, 'destroy should not call cancel when there is no active job')
})

test('ParakeetInterface reload preserves wrapper job numbering across native recreation', async (t) => {
  const binding = new MockedBinding()
  const addon = new ParakeetInterface(binding, {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  }, () => {})

  addon._nextJobId = 7
  addon._activeJobId = 6
  addon._bufferedAudio = [new Float32Array([0.1, 0.2])]

  binding.cancel = async () => {
    addon._addonOutputCallback(addon, 'Error', null, 'Job cancelled')
  }
  await addon.reload({
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt'
  })

  t.is(addon._nextJobId, 7, 'reload should preserve JS-owned job numbering')
  t.is(addon._activeJobId, null, 'reload should clear the previous active job')
  t.is(addon._bufferedAudio.length, 0, 'reload should discard buffered audio from the old instance')
  t.is(await addon.status(), 'loading', 'reload should leave the addon in loading state until activation')
})
