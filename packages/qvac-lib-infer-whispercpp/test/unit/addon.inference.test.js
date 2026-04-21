'use strict'

const test = require('brittle')
const TranscriptionWhispercpp = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')
const MockedBinding = require('../mocks/MockedBinding.js')
const { transitionCb, wait } = require('../mocks/utils.js')
const { WhisperInterface } = require('../../whisper')

const process = require('process')
global.process = process
const sinon = require('sinon')

function createMockedModel ({ onOutput = () => { }, binding = undefined } = {}) {
  // Restore any existing stub first
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()
  // Mock validateModelFiles on the prototype BEFORE creating instance
  const validateStub = sinon.stub(TranscriptionWhispercpp.prototype, 'validateModelFiles').returns(undefined)

  const args = {
    files: {
      model: 'ggml-tiny.bin',
      vadModel: 'ggml-silero-v5.1.2.bin'
    }
  }
  const config = {
    whisperConfig: {
      language: 'en',
      duration_ms: 29000,
      temperature: 0.0,
      vad_model_path: 'ggml-silero-v5.1.2.bin',
      vadParams: {
        threshold: 0.6
      }
    },
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    miscConfig: {
      caption_enabled: false
    }
  }
  const model = new TranscriptionWhispercpp(args, config)

  sinon.stub(model, '_createAddon').callsFake(configurationParams => {
    const _binding = binding || new MockedBinding()
    const addon = new WhisperInterface(_binding, configurationParams, (addon, event, jobId, output, error) => {
      onOutput(addon, event, jobId, output, error)
      model._outputCallback(addon, event, jobId, output, error)
    }, transitionCb)

    return addon
  })

  // Store stub reference for cleanup
  model._validateStub = validateStub

  return model
}

/**
 * Test that the inference process returns the expected output.
 *
 * The test simulates loading the model, running an inference with some sample audio data,
 * and verifies that the output callback receives an object containing the input array's length.
 */
test('Inference returns correct output for audio input', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const model = createMockedModel({ onOutput })
  await model.load()

  // Simulate sending an audio chunk
  const sampleChunk = new Uint8Array([10, 20, 30, 40, 50])
  const jobId1 = await model.addon.append({ type: 'audio', input: sampleChunk })
  t.is(jobId1, 1, 'First job ID should be 1')

  // Append an end-of-job marker.
  const jobIdEnd = await model.addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'Job ID should remain 1 for end-of-job signal')

  await wait()

  // Check that we received an Output event for the audio chunk.
  const outputEvent = events.find(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvent, 'Should receive an Output event for the audio chunk')
  t.ok(outputEvent.output, 'Output event should have output property')
  t.is(outputEvent.output.data, sampleChunk.length, 'Output data should equal the audio chunk length')

  // Check that we received a JobEnded event.
  const jobEndedEvent = events.find(e => e.event === 'JobEnded' && e.jobId === 1)
  t.ok(jobEndedEvent, 'Should receive a JobEnded event for job 1')
})

test('Streaming transcript output preserves segment ordering', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  binding.setScriptedOutputs([
    { text: 'segment-0', toAppend: false, start: 0, end: 1, id: 0 },
    { text: 'segment-1', toAppend: true, start: 1, end: 2, id: 1 },
    { text: 'segment-2', toAppend: true, start: 2, end: 3, id: 2 }
  ])

  const model = createMockedModel({ onOutput, binding })
  await model.load()

  await model.addon.append({ type: 'audio', input: new Uint8Array([1, 2, 3, 4]) })
  await model.addon.append({ type: 'end of job' })
  await wait()

  const outputEvents = events.filter(e => e.event === 'Output' && e.jobId === 1)
  t.alike(
    outputEvents.map(e => e.output[0].text),
    ['segment-0', 'segment-1', 'segment-2'],
    'Output segments should keep original ordering'
  )

  const jobEndedIndex = events.findIndex(e => e.event === 'JobEnded' && e.jobId === 1)
  const lastOutputIndex = events.reduce((idx, evt, i) => {
    return evt.event === 'Output' && evt.jobId === 1 ? i : idx
  }, -1)
  t.ok(jobEndedIndex > lastOutputIndex, 'JobEnded should arrive after the last segment output')
})

test('Cancel clears in-flight job and allows a new run', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  binding.setJobDelayMs(40)
  const model = createMockedModel({ onOutput, binding })
  await model.load()

  await model.addon.append({ type: 'audio', input: new Uint8Array([9, 9, 9]) })
  await model.addon.append({ type: 'end of job' })
  await model.addon.cancel()
  await wait(60)

  t.is(
    events.find(e => e.jobId === 1 && (e.event === 'Output' || e.event === 'JobEnded')),
    undefined,
    'Cancelled job should not emit output or completion events'
  )

  await model.addon.append({ type: 'audio', input: new Uint8Array([1, 2, 3, 4]) })
  await model.addon.append({ type: 'end of job' })
  await wait(60)

  t.ok(
    events.find(e => e.jobId === 2 && e.event === 'JobEnded'),
    'A new job should complete successfully after cancel'
  )
})

test('WhisperInterface runJob preserves active job when native rejects new job', async (t) => {
  const binding = new MockedBinding()
  const addon = new WhisperInterface(binding, {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'en',
      duration_ms: 0,
      temperature: 0.0
    },
    miscConfig: {
      caption_enabled: false
    }
  }, () => {})

  addon._activeJobId = 42
  addon._nextJobId = 43
  addon._setState('processing')
  binding.runJob = () => false

  const accepted = await addon.runJob({
    type: 'audio',
    input: new Uint8Array([1, 2, 3])
  })

  t.is(accepted, false, 'runJob should report rejected when native side is busy')
  t.is(addon._activeJobId, 42, 'Current active job ID should remain unchanged')
  t.is(addon._nextJobId, 43, 'Next job counter should not advance on rejection')
  t.is(await addon.status(), 'processing', 'State should remain unchanged for the current active job')
})

test('WhisperInterface cancel clears active job only after cancel resolves', async (t) => {
  const binding = new MockedBinding()
  const addon = new WhisperInterface(binding, {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'en',
      duration_ms: 0,
      temperature: 0.0
    },
    miscConfig: {
      caption_enabled: false
    }
  }, () => {})

  addon._activeJobId = 7
  addon._setState('processing')
  let sawActiveJobDuringCancel = false

  binding.cancel = async (handle) => {
    t.is(handle, addon._handle, 'cancel should be called with current handle')
    sawActiveJobDuringCancel = addon._activeJobId === 7
    await wait(5)
  }

  await addon.cancel(7)

  t.ok(sawActiveJobDuringCancel, 'Active job should still be set while cancel is in-flight')
  t.is(addon._activeJobId, null, 'Active job should be cleared after cancel resolves')
  t.is(await addon.status(), 'listening', 'State should return to listening after cancel resolves')
})

test('WhisperInterface cancels buffered job before native run starts', async (t) => {
  const events = []
  const binding = new MockedBinding()
  const addon = new WhisperInterface(binding, {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'en',
      duration_ms: 0,
      temperature: 0.0
    },
    miscConfig: {
      caption_enabled: false
    }
  }, (handle, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  })

  const pendingJobId = await addon.append({
    type: 'audio',
    input: new Uint8Array([1, 2, 3, 4])
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

test('WhisperInterface ignores stale wrapper job ids when cancelling', async (t) => {
  const binding = new MockedBinding()
  const addon = new WhisperInterface(binding, {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'en',
      duration_ms: 0,
      temperature: 0.0
    },
    miscConfig: {
      caption_enabled: false
    }
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

test('Destroy fails active response and clears job mapping', async (t) => {
  const binding = new MockedBinding()
  binding.setJobDelayMs(100)

  const model = createMockedModel({ binding })
  await model.load()

  const response = await model.run(new Uint8Array([1, 2, 3, 4, 5]))
  await model.destroy()

  try {
    await response.await()
    t.fail('Active response should fail when model is destroyed')
  } catch (error) {
    t.ok(
      error.message.includes('destroyed') || error.message.includes('cancel'),
      'Destroy should reject active response with a teardown-related reason'
    )
  }

  t.is(model._job.active, null, 'Destroy should clear the single active job handler')
})

test('Orphan native callbacks are ignored when no active job exists', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const model = createMockedModel({ binding, onOutput })
  await model.load()

  binding._callCallbacks('Output', { data: 99 }, null)
  binding._callCallbacks('JobEnded', { totalTime: 0.01, audioDurationMs: 99, totalSamples: 99 }, null)

  t.is(events.length, 0, 'Callbacks without an active job should be ignored')
})

/**
 * Test that the model correctly handles state transitions.
 *
 * The test verifies that calling pause, unpause, stop, and activating/destroying the addon
 * causes the model to report the correct state.
 */
test('Model state transitions are handled correctly', async (t) => {
  const model = createMockedModel()

  await model.load()

  const response = await model.run(new Uint8Array([10, 19, 30, 40, 50]))
  await response._finishPromise

  t.ok(await model.status() === 'listening', 'Status: Model should be listening')

  try {
    await model.pause()
    t.fail('Pause should explicitly reject in runJob mode')
  } catch (error) {
    t.ok(
      error.message.includes('pause is not supported in runJob mode'),
      'Pause should explicitly reject in runJob mode'
    )
  }
  t.ok(await model.status() === 'listening', 'Status: Model should remain listening after unsupported pause')

  await model.unpause()
  t.ok(await model.status() === 'listening', 'Status: Model should be listening')

  await model.addon.activate()
  t.ok(await model.status() === 'listening', 'Status: Model should be listening')

  await model.addon.destroyInstance()
  t.ok(await model.status() === 'idle', 'Status: Model should be idle')
})

/**
 * Test that errors during processing are properly emitted and caught.
 *
 * This test overrides the addon to force an error during the append process.
 */
test('Model emits error events when an error occurs during processing', async (t) => {
  // Create a custom binding that throws an error on append
  const binding = {
    createInstance: () => ({ id: 1 }),
    runJob: () => { throw new Error('Forced error for testing') },
    loadWeights: () => { },
    activate: () => { },
    cancel: () => { },
    destroyInstance: () => { },
    setLogger: () => { },
    releaseLogger: () => { }
  }
  const model = createMockedModel({ binding })

  await model.load()

  try {
    const response = await model.run(new Uint8Array([1, 2, 3]))
    await response.await()
    t.fail('Should have failed the response')
  } catch (error) {
    // The error should be a QvacErrorAddonWhisper
    t.ok(error.constructor.name === 'QvacErrorAddonWhisper', 'Error should be a QvacErrorAddonWhisper')
    // The test is mainly about ensuring errors are caught and wrapped properly
    // The specific error code is less important than the error handling mechanism
    t.ok(error.message.includes('Forced error') || typeof error.code === 'number', 'Error should contain forced error message or have error code')
  }
})

/**
 * Test that the FakeDL loader returns the correct file list and data streams.
 *
 * This test verifies that the loader lists the expected files and that reading from each
 * file stream returns non-empty data.
 */
test('FakeDL returns correct file list and data streams', async (t) => {
  const fakeDL = new FakeDL({})

  const fileList = await fakeDL.list('/')
  t.ok(
    ['0.bin', '1.bin', '2.bin', '3.bin', 'conf.json'].every(f => fileList.includes(f)),
    'File list should match expected files'
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
 * Test the complete sequence of operations for the AddonInterface.
 *
 * This test simulates loading weights, activating the addon, appending text chunks,
 * sending job end signals, and verifying that the output callbacks and job boundaries are handled correctly.
 */
test('AddonInterface full sequence: status, append, and job boundaries', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  const addon = new WhisperInterface(binding, {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'en',
      duration_ms: 0,
      temperature: 0.0
    },
    miscConfig: {
      caption_enabled: false
    }
  }, onOutput, transitionCb)

  let status = await addon.status()
  t.ok(status === 'loading', 'Initial addon status should be "loading"')

  await addon.loadWeights({ dummy: 'weightsData' })

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be "listening" after activation')

  // Append an audio chunk and verify the returned job ID.
  const appendResult1 = await addon.append({ type: 'audio', input: new Uint8Array([1, 2, 3]) })
  t.ok(appendResult1 === 1, 'Job ID should be 1 for the first appended chunk')

  const appendResult2 = await addon.append({ type: 'end of job' })
  t.ok(appendResult2 === 1, 'Job ID should remain 1 for the end-of-job signal')

  // Wait for the output callback to be triggered and verify output data.
  await wait()
  console.log(JSON.stringify(events))
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 1 && e.output && typeof e.output.totalTime === 'number'),
    'JobEnded callback should be emitted for job 1'
  )

  status = await addon.status()
  t.ok(status === 'listening', 'Status should remain "listening" after job end')

  // Append another audio chunk, which should start a new job.
  const appendResult3 = await addon.append({ type: 'audio', input: new Uint8Array([4, 5]) })
  t.ok(appendResult3 === 2, 'Job ID should increment to 2 for a new job')

  // Append another audio chunk; it should belong to the current job (job 2).
  const appendResult4 = await addon.append({ type: 'audio', input: new Uint8Array([6, 7, 8, 9]) })
  t.ok(appendResult4 === 2, 'Job ID should remain 2 for the same job')

  // Append end-of-job signal for job 2.
  const appendResult5 = await addon.append({ type: 'end of job' })
  t.ok(appendResult5 === 2, 'Job ID should be 2 for the end-of-job signal of job 2')
  await wait()
  t.ok(
    events.find(e => e.event === 'Output' && e.jobId === 2 && e.output.data === 6),
    'Output callback should report merged audio length for job 2'
  )
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 2),
    'JobEnded callback should be emitted for job 2'
  )

  // Append a redundant end-of-job marker; this should start a new job (job 3).
  const appendResult6 = await addon.append({ type: 'end of job' })
  t.ok(appendResult6 === 3, 'Job ID should increment to 3 for a redundant end-of-job signal')
  await wait()
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 3),
    'JobEnded callback should be emitted for job 3'
  )

  t.end()
})
