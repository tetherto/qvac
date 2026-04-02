'use strict'

const test = require('brittle')
const sinon = require('sinon')
const ONNXTTS = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const { QvacErrorAddonTTS, ERR_CODES } = require('../../lib/error.js')
const process = require('process')

global.process = process

function createStubbedModel () {
  const model = new ONNXTTS({
    files: { modelDir: './models/chatterbox' },
    engine: 'chatterbox',
    config: { language: 'en', useGPU: false }
  })
  sinon.stub(model, '_createAddon').callsFake((configurationParams, outputCb) => {
    return new TTSInterface(new MockedBinding(), configurationParams, outputCb)
  })
  return model
}

test('unload() clears load flags but not destroyed', async (t) => {
  const model = createStubbedModel()
  await model.load()
  let s = model.getState()
  t.ok(s.configLoaded)
  t.ok(s.weightsLoaded)
  t.not(s.destroyed)

  await model.unload()
  s = model.getState()
  t.not(s.configLoaded)
  t.not(s.weightsLoaded)
  t.not(s.destroyed)
})

test('destroy() clears load flags and sets destroyed', async (t) => {
  const model = createStubbedModel()
  await model.load()
  await model.destroy()
  const s = model.getState()
  t.not(s.configLoaded, 'config should be cleared')
  t.not(s.weightsLoaded, 'weights should be cleared')
  t.ok(s.destroyed, 'destroyed flag should be set')
})

test('destroy() without load still sets destroyed', async (t) => {
  const model = createStubbedModel()
  await model.destroy()
  const s = model.getState()
  t.not(s.configLoaded)
  t.not(s.weightsLoaded)
  t.ok(s.destroyed)
})

test('load() after destroy() rejects with FAILED_TO_LOAD', async (t) => {
  const model = createStubbedModel()
  await model.load()
  await model.destroy()
  try {
    await model.load()
    t.fail('load() should throw after destroy()')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonTTS, 'should throw QvacErrorAddonTTS')
    t.is(err.code, ERR_CODES.FAILED_TO_LOAD, 'code should be FAILED_TO_LOAD')
  }
})
