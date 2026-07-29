'use strict'

const test = require('brittle')
const ASRGgml = require('../../index.js')
const MockedBinding = require('../mocks/MockedBinding.js')
const { MODEL_PATH, createWhisperModel, getAddon } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

function createModel(whisperConfig, extraConfig = {}) {
  const { model, capturedConfig } = createWhisperModel({
    binding: new MockedBinding(),
    files: { model: MODEL_PATH },
    config: { whisperConfig, ...extraConfig }
  })
  return [model, capturedConfig]
}

test('_load strips max_seconds and derives duration_ms', async (t) => {
  const [model, capturedFut] = createModel({ language: 'en', max_seconds: 30 })

  await model.load()
  const captured = await capturedFut

  t.absent(captured.whisperConfig.max_seconds, 'max_seconds must not reach the addon')
  t.is(captured.whisperConfig.duration_ms, 30000, 'duration_ms should be derived from max_seconds')
})

test('driver pins the wire format to f32le and stamps the engine type', async (t) => {
  const [model, capturedFut] = createModel({ language: 'en' })

  await model.load()
  const captured = await capturedFut

  t.is(
    captured.audio_format,
    'f32le',
    'the driver normalizes all input to f32 and pins the native wire format'
  )
  t.is(captured.engineType, 'whisper', 'engineType is stamped for the unified createInstance')
})

test('reload strips max_seconds and derives duration_ms', async (t) => {
  const [model] = createModel({ language: 'en' })
  await model.load()
  const addon = getAddon(model)

  let reloadConfig = null
  const origReload = addon.reload.bind(addon)
  addon.reload = (cfg) => {
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

test('constructor rejects detect_language in whisperConfig', (t) => {
  // Config validation is constructor-time in the unified package (a deliberate
  // tightening over whisper's old load()-time validation).
  try {
    // eslint-disable-next-line no-new
    new ASRGgml({
      files: { model: MODEL_PATH },
      config: {
        engine: 'whisper',
        whisperConfig: { language: 'auto', detect_language: true }
      }
    })
    t.fail('constructor should reject detect_language')
  } catch (err) {
    t.ok(
      /detect_language is not a valid parameter/.test(err.message),
      `detect_language should be rejected end-to-end (got: ${err.message})`
    )
  }
})

test('reload retains instance contextParams and miscConfig', async (t) => {
  const { model } = createWhisperModel({
    binding: new MockedBinding(),
    files: { model: MODEL_PATH },
    config: {
      whisperConfig: { language: 'en' },
      contextParams: { gpu_device: 2 },
      miscConfig: { caption_enabled: true }
    }
  })

  await model.load()
  const addon = getAddon(model)

  let reloadConfig = null
  const origReload = addon.reload.bind(addon)
  addon.reload = (cfg) => {
    reloadConfig = cfg
    return origReload(cfg)
  }

  await model.reload({ whisperConfig: { language: 'es' } })

  t.is(reloadConfig.contextParams.gpu_device, 2, 'reload retains instance contextParams')
  t.ok(reloadConfig.contextParams.model, 'reload contextParams still includes the model path')
  t.is(reloadConfig.miscConfig.caption_enabled, true, 'reload retains instance miscConfig')
})
