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
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()
  const validateStub = sinon.stub(TranscriptionWhispercpp.prototype, 'validateModelFiles').returns(undefined)

  const args = {
    modelName: 'ggml-tiny.bin',
    vadModelName: 'ggml-silero-v5.1.2.bin',
    loader: new FakeDL({}),
    params: {
      language: 'en',
      max_seconds: 29,
      temperature: 0.0
    }
  }
  const config = {
    whisperConfig: {
      language: 'en',
      duration_ms: 29000,
      temperature: 0.0,
      vad_model_path: 'ggml-silero-v5.1.2.bin',
      vadParams: { threshold: 0.6 }
    },
    contextParams: { model: 'ggml-tiny.bin' },
    miscConfig: { caption_enabled: false },
    vadModelPath: '/mock/path/ggml-silero-v5.1.2.bin'
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

  model._validateStub = validateStub
  return model
}

function makeAudioChunks (count, size) {
  const chunks = []
  for (let i = 0; i < count; i++) {
    const chunk = new Uint8Array(size)
    for (let j = 0; j < size; j++) {
      chunk[j] = (i * size + j) & 0xFF
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
    events.find(e => e.event === 'JobEnded'),
    'JobEnded should be emitted after streaming completes'
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

  const jobEnded = events.find(e => e.event === 'JobEnded')
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
    async * [Symbol.asyncIterator] () {
      yield new Uint8Array([1, 2, 3, 4])
      await new Promise(resolve => setTimeout(resolve, 100))
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
      error.message.includes('cancel') || error.message.includes('Cancel') || error.message.includes('failed') || error.message.includes('No active'),
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
    async * [Symbol.asyncIterator] () {
      yield new Uint8Array([10, 20, 30])
      await new Promise(resolve => setTimeout(resolve, 200))
      yield new Uint8Array([40, 50, 60])
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
      error.message.includes('destroyed') || error.message.includes('Destroy') || error.message.includes('cancel') || error.message.includes('No active'),
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

  const goodOutputs = events.filter(e => e.event === 'Output' && e.output !== null)
  t.ok(goodOutputs.length > 0, 'Successful segments should still deliver output')

  const errorEvents = events.filter(e => e.event === 'Error')
  t.ok(errorEvents.length > 0, 'Error event should be emitted for failed processing')
})

test('Starting a second streaming session throws while one is active', async (t) => {
  const binding = new MockedBinding()
  const model = createMockedModel({ binding })
  await model.load()

  const slowStream = {
    async * [Symbol.asyncIterator] () {
      yield new Uint8Array([1, 2])
      await new Promise(resolve => setTimeout(resolve, 500))
      yield new Uint8Array([3, 4])
    }
  }

  await model.runStreaming(slowStream)
  await wait(10)

  try {
    await model.runStreaming([new Uint8Array([9, 9])])
    t.fail('Should not allow a second streaming session')
  } catch (error) {
    t.ok(
      error.message.includes('already') || error.message.includes('running') || error.message.includes('active'),
      'Second streaming session should be rejected'
    )
  }

  await model.cancel()
})
