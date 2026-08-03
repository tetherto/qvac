'use strict'

const test = require('brittle')
const ASRGgml = require('../../index.js')
const MockedBinding = require('../mocks/MockedBinding.js')
const { wait, transitionCb } = require('../mocks/utils.js')
const { MODEL_PATH, createWhisperModel } = require('../mocks/createModel.js')
const { WhisperInterface } = require('../../engines/whisper/whisper.js')

const process = require('bare-process')
global.process = process

function createMockedModel({ onOutput = () => {}, binding = undefined } = {}) {
  const { model } = createWhisperModel({
    binding: binding || new MockedBinding(),
    onOutput,
    config: {
      whisperConfig: {
        language: 'en',
        duration_ms: 29000,
        temperature: 0.0,
        vad_model_path: MODEL_PATH,
        vadParams: { threshold: 0.6 }
      },
      contextParams: { model: MODEL_PATH },
      miscConfig: { caption_enabled: false },
      vadModelPath: MODEL_PATH
    }
  })
  return model
}

function makeAudioChunks(count, size) {
  const chunks = []
  for (let i = 0; i < count; i++) {
    const chunk = new Uint8Array(size)
    for (let j = 0; j < size; j++) {
      chunk[j] = (i * size + j) & 0xff
    }
    chunks.push(chunk)
  }
  return chunks
}

test('runStreaming completes and delivers transcription output', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  binding.setScriptedOutputs([
    { text: 'hello world', toAppend: false, start: 0, end: 5, id: 0 },
    { text: 'second segment', toAppend: true, start: 5, end: 10, id: 1 }
  ])

  const model = createMockedModel({ onOutput, binding })
  await model.load()

  const audioChunks = makeAudioChunks(3, 32000)
  const response = await model.runStreaming(audioChunks)

  const results = []
  response.onUpdate((data) => {
    const items = Array.isArray(data) ? data : [data]
    results.push(...items)
  })

  await response.await()

  t.ok(results.length > 0, 'Should receive transcription output from streaming')
  t.ok(
    events.find((e) => e.event === 'JobEnded'),
    'JobEnded should be emitted after streaming completes'
  )
})

test('runStreaming passes conversation config to native streaming', async (t) => {
  const binding = new MockedBinding()
  binding.setScriptedOutputs([
    { text: 'configured stream', toAppend: false, start: 0, end: 1, id: 0 }
  ])

  const model = createMockedModel({ binding })
  await model.load()

  const response = await model.runStreaming(makeAudioChunks(1, 16000), {
    emitVadEvents: true,
    endOfTurnSilenceMs: 750,
    vadRunIntervalMs: 125
  })
  await response.await()

  t.ok(binding.lastStreamingConfig.emitVadEvents, 'emitVadEvents should be forwarded')
  t.is(
    binding.lastStreamingConfig.endOfTurnSilenceMs,
    750,
    'end-of-turn threshold should be forwarded'
  )
  t.is(binding.lastStreamingConfig.vadRunIntervalMs, 125, 'VAD interval should be forwarded')
})

test('runStreaming rejects unknown per-call streaming options', async (t) => {
  const model = createMockedModel()
  await model.load()

  try {
    await model.runStreaming(makeAudioChunks(1, 16000), {
      emitVadEvents: true,
      chunkMs: 2000 // parakeet-vocabulary key: invalid for the whisper engine
    })
    t.fail('Unknown streaming option should be rejected')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.INVALID_CONFIG,
      'Unknown streaming option rejects with INVALID_CONFIG'
    )
  }

  // The instance stays usable after the rejected call.
  const response = await model.runStreaming(makeAudioChunks(1, 16000))
  await response.await()
  t.pass('A valid streaming session still runs after the rejected options')
})

test('runStreaming forwards VAD and end-of-turn events without ending the job', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  binding.setScriptedOutputs([
    { type: 'vad', speaking: true, probability: 1 },
    { text: 'hello world', toAppend: false, start: 0, end: 5, id: 0 },
    { type: 'endOfTurn', silenceDurationMs: 900 }
  ])

  const model = createMockedModel({ onOutput, binding })
  await model.load()

  const response = await model.runStreaming(makeAudioChunks(2, 16000), {
    emitVadEvents: true,
    endOfTurnSilenceMs: 900
  })

  const updates = []
  response.onUpdate((data) => {
    updates.push(data)
  })

  await response.await()

  t.ok(
    events.find((e) => e.event === 'VadState'),
    'VadState event should be forwarded'
  )
  t.ok(
    events.find((e) => e.event === 'EndOfTurn'),
    'EndOfTurn event should be forwarded'
  )
  t.ok(
    events.find((e) => e.event === 'JobEnded'),
    'JobEnded should still complete the stream'
  )

  const vadUpdate = updates.find((data) => data?.type === 'vad')
  t.ok(vadUpdate, 'VAD event should reach response output')
  t.is(vadUpdate.source, 'silero', 'VAD event should carry the silero source tag')
  t.is(typeof vadUpdate.score, 'number', 'VAD probability is renamed to score')
  t.is(vadUpdate.speaking, true, 'VAD speaking flag passes through')

  const endOfTurnUpdate = updates.find((data) => data?.type === 'endOfTurn')
  t.ok(endOfTurnUpdate, 'EndOfTurn event should reach response output')
  t.is(endOfTurnUpdate.source, 'vad-silence', 'EndOfTurn carries the vad-silence source tag')
  t.is(endOfTurnUpdate.silenceDurationMs, 900, 'EndOfTurn keeps its silence duration')

  t.ok(
    updates.find((data) => Array.isArray(data) && data[0]?.text === 'hello world'),
    'Transcript output should still be delivered as a bare segment array'
  )
})

test('runStreaming delivers accumulated stats across segments', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  binding.setScriptedOutputs([
    { text: 'seg-a', toAppend: false, start: 0, end: 3, id: 0 },
    { text: 'seg-b', toAppend: true, start: 3, end: 6, id: 1 }
  ])

  const model = createMockedModel({ onOutput, binding })
  await model.load()

  const audioChunks = makeAudioChunks(4, 16000)
  const response = await model.runStreaming(audioChunks)
  await response.await()

  const jobEnded = events.find((e) => e.event === 'JobEnded')
  t.ok(jobEnded, 'JobEnded should be emitted')
  t.ok(jobEnded.output.processCalls === 4, 'processCalls should reflect total chunk count')
  t.ok(jobEnded.output.totalSamples > 0, 'totalSamples should be > 0 for accumulated stats')
})

test('Cancel stops an active streaming session', async (t) => {
  const binding = new MockedBinding()
  binding.setJobDelayMs(200)
  binding.setScriptedOutputs([
    { text: 'never delivered', toAppend: false, start: 0, end: 1, id: 0 }
  ])

  const model = createMockedModel({ binding })
  await model.load()

  const slowStream = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([1, 2, 3, 4])
      await new Promise((resolve) => setTimeout(resolve, 100))
      yield new Uint8Array([5, 6, 7, 8])
    }
  }

  const response = await model.runStreaming(slowStream)

  await wait(30)
  await model.cancel()

  try {
    await response.await()
    t.fail('Response should not resolve after cancel')
  } catch (error) {
    t.ok(
      error.message.includes('cancel') ||
        error.message.includes('Cancel') ||
        error.message.includes('failed') ||
        error.message.includes('No active'),
      'Response should fail with a cancellation-related error'
    )
  }
})

test('Destroy cleans up active streaming session', async (t) => {
  const binding = new MockedBinding()
  binding.setScriptedOutputs([
    { text: 'will not finish', toAppend: false, start: 0, end: 1, id: 0 }
  ])

  const model = createMockedModel({ binding })
  await model.load()

  const slowStream = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([10, 20, 30, 40])
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield new Uint8Array([40, 50, 60, 70])
    }
  }

  const response = await model.runStreaming(slowStream)
  await wait(30)
  await model.destroy()

  try {
    await response.await()
    t.fail('Response should fail when model is destroyed mid-stream')
  } catch (error) {
    t.ok(
      error.message.includes('destroyed') ||
        error.message.includes('Destroy') ||
        error.message.includes('cancel') ||
        error.message.includes('No active'),
      'Streaming response should fail on destroy'
    )
  }
})

test('Streaming error propagation surfaces to response', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const binding = new MockedBinding()
  binding.setScriptedOutputs([
    { text: 'good segment', toAppend: false, start: 0, end: 3, id: 0 },
    { text: 'bad segment', toAppend: true, start: 3, end: 6, id: 1 }
  ])
  binding.setStreamingErrorOnSegment(1)

  const model = createMockedModel({ onOutput, binding })
  await model.load()

  const audioChunks = makeAudioChunks(2, 16000)
  const response = await model.runStreaming(audioChunks)

  try {
    await response.await()
    t.fail('Response should fail when segments have processing errors')
  } catch (error) {
    t.ok(error, 'Response should reject with an error when segments fail')
  }

  const goodOutputs = events.filter((e) => e.event === 'Output' && e.output !== null)
  t.ok(goodOutputs.length > 0, 'Successful segments should still deliver output')

  const errorEvents = events.filter((e) => e.event === 'Error')
  t.ok(errorEvents.length > 0, 'Error event should be emitted for failed processing')
})

test('Concurrent work during an open streaming session is rejected, not queued', async (t) => {
  const binding = new MockedBinding()
  const model = createMockedModel({ binding })
  await model.load()

  let releaseStream
  const gate = new Promise((resolve) => {
    releaseStream = resolve
  })
  const slowStream = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([1, 2, 3, 4])
      await gate
    }
  }

  const r1 = await model.runStreaming(slowStream)

  // The open-session guard fires immediately: a concurrent run()/runStreaming()
  // never queues behind a potentially minutes-long mic session.
  try {
    await model.runStreaming([new Uint8Array([9, 9, 9, 9])])
    t.fail('Second streaming session should be rejected while one is open')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.STREAMING_SESSION_ACTIVE,
      'Second session rejects with STREAMING_SESSION_ACTIVE'
    )
  }

  try {
    await model.run([new Uint8Array([9, 9, 9, 9])])
    t.fail('run() should be rejected while a streaming session is open')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.STREAMING_SESSION_ACTIVE,
      'run() rejects with STREAMING_SESSION_ACTIVE'
    )
  }

  releaseStream()
  await r1.await()
  // The open-session flag clears when the session's `done` promise settles,
  // one microtask after the response itself.
  await wait()

  // Once the session settles, new work is accepted again.
  const r2 = await model.run(new Uint8Array([1, 2, 3, 4]))
  await r2.await()
  t.pass('run() succeeds after the streaming session completed')
})

test('finishStreaming clears the active job and returns to listening', (t) => {
  const configurationParams = {
    engineType: 'whisper',
    whisperConfig: { language: 'en' },
    contextParams: { model: MODEL_PATH },
    miscConfig: { caption_enabled: false }
  }
  const addon = new WhisperInterface(
    new MockedBinding(),
    configurationParams,
    () => {},
    transitionCb
  )

  addon.startStreaming({ vadModelPath: MODEL_PATH })
  t.is(addon._activeJobId, 1, 'startStreaming should reserve an active job id')
  t.is(addon._state, 'processing', 'startStreaming should move to processing')

  addon.finishStreaming()
  t.is(addon._activeJobId, null, 'finishStreaming should clear the active job id')
  t.is(addon._state, 'listening', 'finishStreaming should return to listening')
})

test('a refused double startStreaming leaves the live session untouched', (t) => {
  // The interface used to claim the new job id and move to PROCESSING BEFORE
  // calling native, and its catch reset the job id to null / the state to
  // LISTENING — so the native double-start refusal clobbered the bookkeeping
  // of the session that was still running. ParakeetInterface guards up front;
  // so does this one now.
  const addon = new WhisperInterface(
    new MockedBinding(),
    {
      engineType: 'whisper',
      whisperConfig: { language: 'en' },
      contextParams: { model: MODEL_PATH },
      miscConfig: { caption_enabled: false }
    },
    () => {},
    transitionCb
  )

  addon.startStreaming({ vadModelPath: MODEL_PATH })
  const liveJobId = addon._activeJobId
  t.ok(liveJobId !== null, 'session #1 owns a job id')

  try {
    addon.startStreaming({ vadModelPath: MODEL_PATH })
    t.fail('a second startStreaming must be refused')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.FAILED_TO_START_STREAMING,
      'refused with FAILED_TO_START_STREAMING (6012)'
    )
    t.ok(/already active/.test(error.message), 'the message says why')
  }

  t.is(addon._activeJobId, liveJobId, "the live session's job id survives the refusal")
  t.is(addon._state, 'processing', 'and so does its state')

  addon.finishStreaming()
})
