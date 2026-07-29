'use strict'

const test = require('brittle')
const TranscriptionWhispercpp = require('../../index.js')
const MockedBinding = require('../mocks/MockedBinding.js')
const { transitionCb } = require('../mocks/utils.js')
const { WhisperInterface } = require('../../whisper')

const process = require('bare-process')
global.process = process

function createModel(whisperConfig) {
  TranscriptionWhispercpp.prototype.validateModelFiles = () => undefined

  const args = { files: { model: 'ggml-tiny.bin' } }
  const model = new TranscriptionWhispercpp(args, { whisperConfig })

  let resolveCaptured
  const captured = new Promise((resolve) => {
    resolveCaptured = resolve
  })
  model._createAddon = (configurationParams) => {
    resolveCaptured(configurationParams)
    return new WhisperInterface(new MockedBinding(), configurationParams, () => {}, transitionCb)
  }
  return [model, captured]
}

test('_load strips max_seconds and derives duration_ms', async (t) => {
  const [model, capturedFut] = createModel({ language: 'en', max_seconds: 30 })

  await model.load()
  const captured = await capturedFut

  t.absent(captured.whisperConfig.max_seconds, 'max_seconds must not reach the addon')
  t.is(captured.whisperConfig.duration_ms, 30000, 'duration_ms should be derived from max_seconds')
})

test('reload strips max_seconds and derives duration_ms', async (t) => {
  const [model] = createModel({ language: 'en' })
  await model.load()

  let reloadConfig = null
  const origReload = model.addon.reload.bind(model.addon)
  model.addon.reload = (cfg) => {
    reloadConfig = cfg
    return origReload(cfg)
  }

  await model.reload({ whisperConfig: { max_seconds: 15 } })

  t.absent(reloadConfig.whisperConfig.max_seconds, 'max_seconds must not reach the addon on reload')
  t.is(
    reloadConfig.whisperConfig.duration_ms,
    15000,
    'reload duration_ms should be derived from max_seconds'
  )
})

test('_load rejects detect_language in whisperConfig', async (t) => {
  const [model] = createModel({ language: 'auto', detect_language: true })

  try {
    await model.load()
    t.fail('load should reject detect_language')
  } catch (err) {
    t.ok(
      /detect_language is not a valid parameter/.test(err.message),
      `detect_language should be rejected end-to-end (got: ${err.message})`
    )
  }
})

test('reload retains instance contextParams and miscConfig', async (t) => {
  TranscriptionWhispercpp.prototype.validateModelFiles = () => undefined

  const args = { files: { model: 'ggml-tiny.bin' } }
  const model = new TranscriptionWhispercpp(args, {
    whisperConfig: { language: 'en' },
    contextParams: { gpu_device: 2 },
    miscConfig: { caption_enabled: true }
  })
  model._createAddon = (configurationParams) =>
    new WhisperInterface(new MockedBinding(), configurationParams, () => {}, transitionCb)

  await model.load()

  let reloadConfig = null
  const origReload = model.addon.reload.bind(model.addon)
  model.addon.reload = (cfg) => {
    reloadConfig = cfg
    return origReload(cfg)
  }

  await model.reload({ whisperConfig: { language: 'es' } })

  t.is(reloadConfig.contextParams.gpu_device, 2, 'reload retains instance contextParams')
  t.ok(reloadConfig.contextParams.model, 'reload contextParams still includes the model path')
  t.is(reloadConfig.miscConfig.caption_enabled, true, 'reload retains instance miscConfig')
})
