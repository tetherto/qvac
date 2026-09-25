'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

const SFX_MODEL = './models/moss-sfx-v2-f16.gguf'
const BACKBONE = './models/moss-tts-delay-f16.gguf'
const DECODER = './models/moss-codec-decoder-f16.gguf'
const NATIVE_RATE = 48000

class RecordingBinding extends MockedBinding {
  constructor(opts) {
    super(opts)
    this.jobs = []
  }

  runJob(handle, data) {
    this.jobs.push(data)
    return super.runJob(handle, data)
  }
}

function createMockedSfxModel({ binding, files, extra = {} } = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS_SFX,
    files: files || { mossSoundEffect: SFX_MODEL },
    opts: { stats: true },
    ...extra
  })
  model._createAddon = (configurationParams, outputCb) =>
    new TTSInterface(binding || new MockedBinding(), configurationParams, outputCb)
  return model
}

function withTempDir(name, body) {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const root = path.join(os.tmpdir(), `${name}-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  try {
    return body(root, fs)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch (_e) {}
  }
}

async function runRecorded(fields) {
  const binding = new RecordingBinding()
  const model = createMockedSfxModel({ binding })
  await model.load()
  const response = await model.run({ type: 'text', input: 'Rain on a tin roof.', ...fields })
  await response.await()
  await model.unload()
  return binding.jobs
}

test('MOSS-SFX: explicit engine option routes to moss-sfx', (t) => {
  const model = createMockedSfxModel()
  t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS_SFX)
  t.is(model._mossSoundEffectPath, SFX_MODEL)
  t.absent(model._mossBackbonePath, 'no delay backbone on moss-sfx')
})

test('MOSS-SFX: the model file alone routes to moss-sfx, under either alias', (t) => {
  t.is(
    new TTSGgml({ files: { mossSoundEffect: SFX_MODEL } }).getEngineType(),
    TTSGgml.ENGINE_MOSS_SFX
  )
  const aliased = new TTSGgml({ files: { mossSoundEffectPath: SFX_MODEL } })
  t.is(aliased.getEngineType(), TTSGgml.ENGINE_MOSS_SFX)
  t.is(aliased._mossSoundEffectPath, SFX_MODEL)
})

test('MOSS-SFX: modelDir auto-detect finds the sound-effect GGUF', (t) => {
  withTempDir('tts-ggml-moss-sfx-detect', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-sfx-v2-f16.gguf'), 'sfx')
    const model = new TTSGgml({ files: { modelDir: root } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS_SFX)
    t.is(model._mossSoundEffectPath, path.join(root, 'moss-sfx-v2-f16.gguf'))
  })
})

test('MOSS-SFX: modelDir prefers the q8_0 quant, and MOSS Delay keeps precedence', (t) => {
  withTempDir('tts-ggml-moss-sfx-rank', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-sfx-v2-f16.gguf'), 'f16')
    fs.writeFileSync(path.join(root, 'moss-sfx-v2-q8_0.gguf'), 'q8')
    t.is(
      new TTSGgml({ files: { modelDir: root } })._mossSoundEffectPath,
      path.join(root, 'moss-sfx-v2-q8_0.gguf')
    )
    fs.writeFileSync(path.join(root, 'moss-tts-delay-f16.gguf'), 'moss')
    t.is(new TTSGgml({ files: { modelDir: root } }).getEngineType(), TTSGgml.ENGINE_MOSS)
  })
})

test('MOSS-SFX: ttsParams carry the model and the runtime options', (t) => {
  const model = createMockedSfxModel({
    extra: { seed: 7, threads: 2, config: { useGPU: true }, backendsDir: '/opt/backends' }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_MOSS_SFX)
  t.is(params.mossSoundEffectPath, SFX_MODEL)
  t.is(params.seed, 7)
  t.is(params.threads, 2)
  t.is(params.useGPU, true)
  t.ok(String(params.backendsDir).startsWith('/opt/backends'))
  t.absent(params.mossBackbonePath, 'no delay paths leak into the params')
})

test('MOSS-SFX: an engine without its GGUF fails at construction', (t) => {
  withTempDir('tts-ggml-moss-sfx-empty', (root) => {
    t.exception(
      () => new TTSGgml({ engine: TTSGgml.ENGINE_MOSS_SFX, files: { modelDir: root } }),
      /moss-sfx engine needs its GGUF/
    )
  })
})

test('MOSS-SFX: constructor rejects what the engine cannot do', (t) => {
  t.exception(
    () =>
      createMockedSfxModel({
        extra: { files: { mossSoundEffect: SFX_MODEL, lavasrEnhancer: '/e.gguf' } }
      }),
    /LavaSR enhancer\/denoiser are not supported with the moss-sfx engine/
  )
  t.exception(
    () => createMockedSfxModel({ extra: { referenceAudio: '/abs/voice.wav' } }),
    /referenceAudio is not supported by the moss-sfx engine/
  )
  t.exception(
    () => createMockedSfxModel({ extra: { config: { outputSampleRate: 24000 } } }),
    /moss-sfx engine outputs 48000 Hz/
  )
  t.exception(
    () => createMockedSfxModel({ extra: { streamChunkTokens: 25 } }),
    /not supported by the moss-sfx engine/
  )
  t.exception(() => createMockedSfxModel({ extra: { durationTokens: 38 } }), /moss-only options/)
})

test('MOSS-SFX: the native rate is accepted when named explicitly', (t) => {
  const model = createMockedSfxModel({ extra: { config: { outputSampleRate: NATIVE_RATE } } })
  t.is(model._buildTtsParams().outputSampleRate, NATIVE_RATE)
})

test('MOSS-SFX: a plain run sends only the prompt', async (t) => {
  const jobs = await runRecorded({})
  t.alike(jobs, [{ type: 'text', input: 'Rain on a tin roof.' }])
})

test('MOSS-SFX: per-call generation controls reach the job', async (t) => {
  const jobs = await runRecorded({
    seconds: 2.5,
    negativePrompt: 'music',
    steps: 20,
    guidance: 3.5,
    shift: 4
  })
  t.alike(jobs, [
    {
      type: 'text',
      input: 'Rain on a tin roof.',
      seconds: 2.5,
      negativePrompt: 'music',
      steps: 20,
      guidance: 3.5,
      shift: 4
    }
  ])
})

test('MOSS-SFX: out-of-range controls are rejected before queueing', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedSfxModel({ binding })
  await model.load()
  const cases = [
    [{ seconds: 0 }, /seconds must be in \(0, 30\]/],
    [{ seconds: 31 }, /seconds must be in \(0, 30\]/],
    [{ seconds: Number.NaN }, /seconds must be/],
    [{ steps: 0 }, /steps must be an integer in \[1, 1000\]/],
    [{ steps: 2.5 }, /steps must be an integer/],
    [{ guidance: 0.5 }, /guidance must be in \[1, 50\]/],
    [{ shift: -1 }, /shift must be in \(0, 100\]/],
    [{ negativePrompt: 7 }, /negativePrompt must be a string/]
  ]
  for (const [fields, pattern] of cases) {
    await t.exception(model.run({ type: 'text', input: 'x', ...fields }), pattern)
  }
  t.is(binding.jobs.length, 0, 'no job queued')
  await model.unload()
})

test('MOSS-SFX: sound-effect controls on another engine throw', async (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS,
    files: { mossBackbone: BACKBONE, mossCodecDecoder: DECODER }
  })
  model._createAddon = (params, cb) => new TTSInterface(new MockedBinding(), params, cb)
  await model.load()
  await t.exception(model.run({ type: 'text', input: 'x', seconds: 5 }), /moss-sfx-only options/)
  await model.unload()
})

test('MOSS-SFX: voice and conditioning fields are rejected per call', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedSfxModel({ binding })
  await model.load()
  await t.exception(
    model.run({ type: 'text', input: 'x', referenceAudio: '/abs/voice.wav' }),
    /audio8-only/
  )
  await t.exception(model.run({ type: 'text', input: 'x', emotion: 'happy' }))
  t.is(binding.jobs.length, 0, 'no job queued')
  await model.unload()
})

test('MOSS-SFX: there is no sentence streaming', async (t) => {
  const model = createMockedSfxModel()
  await model.load()
  await t.exception(
    model.runStream('A dog barks. A door opens.'),
    /moss-sfx engine generates a whole sound effect/
  )
  await t.exception(model.run({ input: 'A dog barks.', streamOutput: true }), /does not stream/)
  await t.exception(model.runStreaming(['A dog barks.']), /does not stream/)
  await model.unload()
})

test('MOSS-SFX: reload keeps the model and refuses a non-native output rate', async (t) => {
  const model = createMockedSfxModel()
  await model.load()
  await model.reload({ useGPU: true })
  t.is(model._buildTtsParams().mossSoundEffectPath, SFX_MODEL)
  t.is(model._buildTtsParams().useGPU, true)
  await t.exception(model.reload({ outputSampleRate: 24000 }), /moss-sfx engine outputs 48000 Hz/)
  t.absent(model._buildTtsParams().outputSampleRate, 'the refused rate is rolled back')
  await model.unload()
})
