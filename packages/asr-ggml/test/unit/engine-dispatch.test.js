'use strict'

// Engine resolution for the unified ASRGgml constructor:
//   config.engine  >  options.engine  >  magic-byte sniff of files.model
// (ASCII "GGUF" -> parakeet, anything else -> whisper/legacy GGML), with the
// structured INVALID_ENGINE error on unknown strings, on a config object that
// omits its discriminant, and MODEL_REQUIRED / MODEL_NOT_FOUND on bad files.

const test = require('brittle')
const ASRGgml = require('../../index.js')
const {
  MODEL_PATH,
  GGUF_FIXTURE_PATH,
  GGML_FIXTURE_PATH,
  createWhisperModel,
  createParakeetModel
} = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

test('exported engine constants match the discriminant strings', (t) => {
  t.is(ASRGgml.ENGINE_WHISPER, 'whisper')
  t.is(ASRGgml.ENGINE_PARAKEET, 'parakeet')
})

test('config.engine resolves the engine', (t) => {
  const whisper = new ASRGgml({
    files: { model: MODEL_PATH },
    config: { engine: 'whisper' }
  })
  t.is(whisper.getEngineType(), 'whisper')

  const parakeet = new ASRGgml({
    files: { model: MODEL_PATH },
    config: { engine: 'parakeet' }
  })
  t.is(parakeet.getEngineType(), 'parakeet')
})

test('options.engine alias works when config is omitted', (t) => {
  const model = new ASRGgml({
    files: { model: MODEL_PATH },
    engine: 'parakeet'
  })
  t.is(model.getEngineType(), 'parakeet', 'engine alias resolves without a config object')
})

test('config.engine wins over the options.engine alias', (t) => {
  const model = new ASRGgml({
    files: { model: MODEL_PATH },
    engine: 'whisper',
    config: { engine: 'parakeet' }
  })
  t.is(model.getEngineType(), 'parakeet', 'the config discriminant wins on conflict')
})

test('magic-byte sniff: GGUF file resolves to parakeet', (t) => {
  const model = new ASRGgml({ files: { model: GGUF_FIXTURE_PATH } })
  t.is(model.getEngineType(), 'parakeet', 'ASCII GGUF magic sniffs to parakeet')
})

test('magic-byte sniff: legacy GGML .bin resolves to whisper', (t) => {
  const fixture = new ASRGgml({ files: { model: GGML_FIXTURE_PATH } })
  t.is(fixture.getEngineType(), 'whisper', 'non-GGUF magic sniffs to whisper')

  const realModel = new ASRGgml({ files: { model: MODEL_PATH } })
  t.is(realModel.getEngineType(), 'whisper', 'the real GGML tiny model sniffs to whisper')
})

test('unknown engine string throws INVALID_ENGINE', (t) => {
  try {
    // eslint-disable-next-line no-new
    new ASRGgml({
      files: { model: MODEL_PATH },
      config: { engine: 'qwen-asr' }
    })
    t.fail('Unknown engine string should throw')
  } catch (error) {
    t.is(error.code, ASRGgml.ERR_CODES.INVALID_ENGINE, 'throws INVALID_ENGINE (6021)')
    t.is(error.constructor.name, 'QvacErrorAddonASRGgml', 'uses the unified error class')
  }
})

test('config without an engine discriminant throws INVALID_ENGINE', (t) => {
  try {
    // eslint-disable-next-line no-new
    new ASRGgml({
      files: { model: MODEL_PATH },
      config: { whisperConfig: { language: 'en' } }
    })
    t.fail('A config object without engine should throw')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.INVALID_ENGINE,
      'config present without engine keeps the union honest'
    )
  }
})

test('missing model path throws MODEL_REQUIRED', (t) => {
  for (const files of [undefined, {}, { model: '' }]) {
    try {
      // eslint-disable-next-line no-new
      new ASRGgml({ files, engine: 'whisper' })
      t.fail('Missing model should throw MODEL_REQUIRED')
    } catch (error) {
      t.is(error.code, ASRGgml.ERR_CODES.MODEL_REQUIRED, 'throws MODEL_REQUIRED (6017)')
    }
  }
})

test('nonexistent model file throws MODEL_NOT_FOUND for both engines', (t) => {
  for (const engine of ['whisper', 'parakeet']) {
    try {
      // eslint-disable-next-line no-new
      new ASRGgml({
        files: { model: '/definitely/not/a/real/model.bin' },
        engine
      })
      t.fail(`${engine}: nonexistent model should throw`)
    } catch (error) {
      t.is(
        error.code,
        ASRGgml.ERR_CODES.MODEL_NOT_FOUND,
        `${engine}: strict file validation throws MODEL_NOT_FOUND`
      )
    }
  }
})

test('nonexistent whisper VAD model throws VAD_MODEL_NOT_FOUND', (t) => {
  try {
    // eslint-disable-next-line no-new
    new ASRGgml({
      files: { model: MODEL_PATH, vadModel: '/not/a/real/silero.bin' },
      engine: 'whisper'
    })
    t.fail('Nonexistent VAD model should throw')
  } catch (error) {
    t.is(error.code, ASRGgml.ERR_CODES.VAD_MODEL_NOT_FOUND, 'throws VAD_MODEL_NOT_FOUND (6018)')
  }
})

test('drivers stamp engineType onto the native createInstance params', async (t) => {
  const whisper = createWhisperModel()
  await whisper.model.load()
  t.is(whisper.binding.engineType, 'whisper', 'whisper driver passes engineType to createInstance')
  await whisper.model.destroy()

  const parakeet = createParakeetModel()
  await parakeet.model.load()
  t.is(
    parakeet.binding.engineType,
    'parakeet',
    'parakeet driver passes engineType to createInstance'
  )
  await parakeet.model.destroy()
})

test('getBackendInfo returns null before load and an info object after', async (t) => {
  const { model } = createParakeetModel()
  t.is(model.getBackendInfo(), null, 'null before load')

  await model.load()
  const info = model.getBackendInfo()
  t.ok(info, 'backend info available after load')
  t.is(typeof info.backendId, 'number', 'backendId is numeric')
  t.is(typeof info.backendName, 'string', 'backendName is a string')
  await model.destroy()
})

test('whisper getBackendInfo feature-detects the native verb', async (t) => {
  // The unit mock ships the new verb, so info must flow through.
  const withVerb = createWhisperModel()
  await withVerb.model.load()
  const info = withVerb.model.getBackendInfo()
  t.ok(info, 'backend info available when the binding has getBackendInfo')
  t.is(typeof info.gpuMemTotalMb, 'number', 'whisper extras are present')
  await withVerb.model.destroy()

  // An old binding without the verb degrades to null, not a crash.
  const legacyBinding = new (require('../mocks/MockedBinding.js'))()
  legacyBinding.getBackendInfo = undefined // shadow the prototype method
  const legacy = createWhisperModel({ binding: legacyBinding })
  await legacy.model.load()
  t.is(
    legacy.model.getBackendInfo(),
    null,
    'missing native verb degrades to null (feature detection)'
  )
  await legacy.model.destroy()
})
