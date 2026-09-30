'use strict'

const test = require('brittle')
const ASRGgml = require('../../index.js')
const ParakeetMockedBinding = require('../mocks/ParakeetMockedBinding.js')
const { MODEL_PATH, getDriver, getAddon } = require('../mocks/createModel.js')
const { ParakeetInterface } = require('../../engines/parakeet/parakeet.js')
const { transitionCb } = require('../mocks/utils.js')

const process = require('bare-process')
global.process = process

const SAMPLE_RATE = 16000
const SEGMENTS = [
  { text: 'Hola, ¿qué tal?', start: 0.5, end: 1.8, speaker: 'S01', speakerId: 0, toAppend: true },
  { text: 'Muy bien, gracias.', start: 2.1, end: 3.4, speaker: 'S02', speakerId: 1, toAppend: true }
]

class MossBinding extends ParakeetMockedBinding {
  constructor() {
    super()
    this.jobs = []
  }

  createInstance(interfaceType, configurationParams, outputCb, stateCb = null) {
    this.configurationParams = configurationParams
    return super.createInstance(
      interfaceType,
      { ...configurationParams, engineType: 'parakeet' },
      outputCb,
      stateCb
    )
  }

  runJob(handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this.jobs.push(data)
    process.nextTick(() => {
      this._callCallbacks('Output', SEGMENTS, null)
      this._callCallbacks(
        'RuntimeStats',
        { totalTime: 0.4, audioDurationMs: 3400, segments: 2, generatedTokens: 40 },
        null
      )
    })
    return true
  }
}

function createMossModel({ binding = new MossBinding(), mossTranscribeConfig = {} } = {}) {
  const model = new ASRGgml({
    files: { model: MODEL_PATH },
    config: { engine: 'moss-transcribe', mossTranscribeConfig }
  })
  const driver = getDriver(model)
  driver._createAddon = (configurationParams) =>
    new ParakeetInterface(
      binding,
      configurationParams,
      driver._outputCallback.bind(driver),
      transitionCb
    )
  return { model, binding }
}

function speech(seconds = 1) {
  return new Float32Array(seconds * SAMPLE_RATE).fill(0.1)
}

async function transcribe(model, options) {
  const response = await model.run(speech(), options)
  const segments = []
  await response
    .onUpdate((output) => {
      if (Array.isArray(output)) segments.push(...output)
    })
    .await()
  return segments
}

test('MOSS-Transcribe: the explicit engine builds the moss driver and native config', async (t) => {
  const { model, binding } = createMossModel({
    mossTranscribeConfig: { maxThreads: 6, useGPU: true, backendsDir: '/opt/backends' }
  })
  t.is(getDriver(model).engineType, ASRGgml.ENGINE_MOSS_TRANSCRIBE)
  await model.load()
  t.is(binding.configurationParams.engineType, 'moss-transcribe')
  t.is(binding.configurationParams.modelPath, MODEL_PATH)
  t.is(binding.configurationParams.maxThreads, 6)
  t.is(binding.configurationParams.useGPU, true)
  t.is(binding.configurationParams.backendsDir, '/opt/backends')
  await model.destroy()
})

test('MOSS-Transcribe: the engine alias and config.engine both select it', (t) => {
  const aliased = new ASRGgml({ files: { model: MODEL_PATH }, engine: 'moss-transcribe' })
  t.is(getDriver(aliased).engineType, 'moss-transcribe')
})

test('MOSS-Transcribe: unknown config keys are rejected', (t) => {
  t.exception(
    () =>
      new ASRGgml({
        files: { model: MODEL_PATH },
        config: { engine: 'moss-transcribe', mossTranscribeConfig: { language: 'es' } }
      }),
    /language is not a valid parameter for mossTranscribeConfig/
  )
})

test('MOSS-Transcribe: segments carry the speaker label and id', async (t) => {
  const { model } = createMossModel()
  await model.load()
  const segments = await transcribe(model)
  t.is(segments.length, 2)
  t.is(segments[0].speaker, 'S01')
  t.is(segments[0].speakerId, 0)
  t.is(segments[1].speaker, 'S02')
  t.is(segments[1].start, 2.1)
  await model.destroy()
})

test('MOSS-Transcribe: a plain run sends only the audio', async (t) => {
  const { model, binding } = createMossModel()
  await model.load()
  await transcribe(model)
  t.is(binding.jobs.length, 1)
  t.is(binding.jobs[0].type, 'audio')
  t.ok(binding.jobs[0].input instanceof Float32Array, 'audio travels as Float32Array')
  t.absent(binding.jobs[0].hotwords, 'no hotwords unless asked for')
  await model.destroy()
})

test('MOSS-Transcribe: hotwords and maxNewTokens reach the native job', async (t) => {
  const { model, binding } = createMossModel()
  await model.load()
  await transcribe(model, { hotwords: ['QVAC', 'vcpkg', 'Parakeet'], maxNewTokens: 512 })
  t.alike(binding.jobs[0].hotwords, ['QVAC', 'vcpkg', 'Parakeet'])
  t.is(binding.jobs[0].maxNewTokens, 512)
  await model.destroy()
})

test('MOSS-Transcribe: a custom prompt reaches the native job', async (t) => {
  const { model, binding } = createMossModel()
  await model.load()
  await transcribe(model, { prompt: 'Transcribe the audio.' })
  t.is(binding.jobs[0].prompt, 'Transcribe the audio.')
  await model.destroy()
})

test('MOSS-Transcribe: malformed run options are rejected before queueing', async (t) => {
  const { model, binding } = createMossModel()
  await model.load()
  const cases = [
    [{ hotwords: 'QVAC' }, /hotwords must be an array/],
    [{ hotwords: [''] }, /non-empty strings/],
    [{ hotwords: ['x'.repeat(65)] }, /at most 64 UTF-8 bytes/],
    [{ hotwords: ['技'.repeat(22)] }, /at most 64 UTF-8 bytes/],
    [{ hotwords: Array.from({ length: 65 }, (_, i) => `w${i}`) }, /up to 64/],
    [{ prompt: 7 }, /prompt must be a string/],
    [{ prompt: 'x', hotwords: ['QVAC'] }, /cannot be combined with hotwords/],
    [{ maxNewTokens: -1 }, /maxNewTokens must be a non-negative integer/],
    [{ maxNewTokens: 1.5 }, /maxNewTokens must be a non-negative integer/],
    [{ language: 'es' }, /language is not a valid moss-transcribe run option/]
  ]
  for (const [options, pattern] of cases) {
    await t.exception(model.run(speech(), options), pattern)
  }
  t.is(binding.jobs.length, 0, 'no job queued')
  await model.destroy()
})

test('MOSS-Transcribe: streaming and reload are not supported', async (t) => {
  const { model } = createMossModel()
  await model.load()
  await t.exception(model.runStreaming(speech()), /moss-transcribe transcribes whole recordings/)
  await t.exception(model.reload({}))
  await model.destroy()
})

test('MOSS-Transcribe: run options on the parakeet engine are rejected', async (t) => {
  const model = new ASRGgml({ files: { model: MODEL_PATH }, config: { engine: 'parakeet' } })
  const driver = getDriver(model)
  driver._createAddon = (configurationParams) =>
    new ParakeetInterface(
      new ParakeetMockedBinding(),
      configurationParams,
      driver._outputCallback.bind(driver),
      transitionCb
    )
  await model.load()
  await t.exception(
    model.run(speech(), { hotwords: ['QVAC'] }),
    /run options are moss-transcribe only \(engine is parakeet\)/
  )
  t.ok(getAddon(model), 'the parakeet instance stays usable')
  await model.destroy()
})
