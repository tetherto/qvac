'use strict'

const test = require('brittle')
const sinon = require('sinon')
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
