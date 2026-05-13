'use strict'

const test = require('brittle')
const sinon = require('sinon')
const { buildSentenceEndTester } = require('../../lib/textStreamAccumulator.js')
const ONNXTTS = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('process')

global.process = process

function createStubbedModel (opts = {}) {
  const model = new ONNXTTS({
    files: { modelDir: './models/chatterbox' },
    engine: 'chatterbox',
    config: { language: 'en', useGPU: false },
    opts: { stats: true },
    ...opts
  })
  sinon.stub(model, '_createAddon').callsFake((configurationParams, outputCb) => {
    return new TTSInterface(new MockedBinding({ jobDelayMs: 5 }), configurationParams, outputCb)
  })
  return model
}

test('runStream runs multiple native jobs and enriches output (onUpdate + await)', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  const text =
    'This is long text one. This is long text two. This is long text three.'
  const response = await model.runStream(text, { maxChunkScalars: 18 })
  const updates = []
  response.onUpdate(d => {
    updates.push(d)
  })
  await response.await()
  t.ok(runJobSpy.callCount >= 2, 'expected multiple runJob calls')
  const withChunk = updates.filter(u => u.chunkIndex !== undefined)
  t.ok(withChunk.length >= 2, 'expected chunk metadata on outputs')
  t.is(withChunk[0].chunkIndex, 0)
  t.ok(typeof withChunk[0].sentenceChunk === 'string')
  t.ok(response.stats && typeof response.stats.totalTime === 'number')
  runJobSpy.restore()
})

test('run({ streamOutput: true }) matches chunked runStream behavior', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  const text =
    'This is long text one. This is long text two. This is long text three.'
  const response = await model.run({
    input: text,
    streamOutput: true,
    maxChunkScalars: 18
  })
  const updates = []
  response.onUpdate(d => {
    updates.push(d)
  })
  await response.await()
  t.ok(runJobSpy.callCount >= 2, 'expected multiple runJob calls')
  const withChunk = updates.filter(u => u.chunkIndex !== undefined)
  t.ok(withChunk.length >= 2, 'expected chunk metadata on outputs')
  t.is(withChunk[0].chunkIndex, 0)
  t.ok(typeof withChunk[0].sentenceChunk === 'string')
  t.ok(response.stats && typeof response.stats.totalTime === 'number')
  runJobSpy.restore()
})

test('runStreaming accumulate merges token stream into one job when sentence completes', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  async function * tokens () {
    yield 'One '
    yield 'sentence '
    yield 'only.'
  }
  const response = await model.runStreaming(tokens())
  await response.await()
  t.is(runJobSpy.callCount, 1)
  runJobSpy.restore()
})

test('runStreaming accumulateSentences false runs one job per yield', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  async function * tokens () {
    yield 'a'
    yield 'b'
  }
  const response = await model.runStreaming(tokens(), { accumulateSentences: false })
  await response.await()
  t.is(runJobSpy.callCount, 2)
  runJobSpy.restore()
})

test('runStreaming accumulate hard-splits when buffer exceeds maxBufferScalars', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  async function * oneBig () {
    yield 'a'.repeat(250)
  }
  const response = await model.runStreaming(oneBig(), { maxBufferScalars: 100 })
  await response.await()
  t.is(runJobSpy.callCount, 3)
  runJobSpy.restore()
})

test('runStreaming maxBufferScalars 0 falls back to default (no infinite loop)', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  async function * oneBig () {
    yield 'a'.repeat(250)
  }
  const response = await model.runStreaming(oneBig(), { maxBufferScalars: 0 })
  await response.await()
  t.is(runJobSpy.callCount, 1, '250 graphemes under default max ~300 → one job')
  runJobSpy.restore()
})

test('buildSentenceEndTester resets global delimiter lastIndex before each test', (t) => {
  const delimiter = /[.!?]\s*$/g
  const testEnd = buildSentenceEndTester({ sentenceDelimiter: delimiter })
  t.ok(testEnd('A.'))
  t.ok(testEnd('B.'), 'second buffer must match from lastIndex 0 (global /g otherwise sticks)')
})

test('runStreaming custom sentenceDelimiter with /g still flushes each fragment', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  const delimiter = /[.!?]\s*$/g
  async function * parts () {
    yield 'A.'
    yield 'B.'
  }
  const response = await model.runStreaming(parts(), { sentenceDelimiter: delimiter })
  await response.await()
  t.is(runJobSpy.callCount, 2)
  runJobSpy.restore()
})

test('runStreaming yields multiple jobs from async text chunks', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()

  async function * lines () {
    yield 'First sentence for TTS.'
    yield 'Second sentence follows.'
    yield 'Third sentence ends here.'
  }

  const response = await model.runStreaming(lines())
  const updates = []
  response.onUpdate(d => {
    updates.push(d)
  })
  await response.await()
  t.is(runJobSpy.callCount, 3, 'expected one runJob per yielded string')
  const withChunk = updates.filter(u => u.chunkIndex !== undefined)
  t.is(withChunk.length, 3)
  t.is(withChunk[0].chunkIndex, 0)
  t.is(withChunk[2].chunkIndex, 2)
  t.ok(typeof withChunk[1].sentenceChunk === 'string')
  runJobSpy.restore()
})

test('plain run() uses single job', async (t) => {
  const runJobSpy = sinon.spy(MockedBinding.prototype, 'runJob')
  const model = createStubbedModel()
  await model.load()
  const response = await model.run({
    input: 'Single block of text without extra splitting.'
  })
  const updates = []
  for await (const d of response.iterate()) {
    updates.push(d)
  }
  await response.await()
  t.is(runJobSpy.callCount, 1)
  const withChunk = updates.filter(u => u.chunkIndex !== undefined)
  t.is(withChunk.length, 0)
  runJobSpy.restore()
})
