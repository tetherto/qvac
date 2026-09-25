'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

const BACKBONE = './models/moss-tts-delay-f16.gguf'
const DECODER = './models/moss-codec-decoder-f16.gguf'
const ENCODER = './models/moss-codec-encoder-f16.gguf'
const FRAMES_PER_MOCK_JOB = 11

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

class FrameReportingBinding extends MockedBinding {
  _callCallbacks(type, data, error) {
    if (type !== 'RuntimeStats') return super._callCallbacks(type, data, error)
    return super._callCallbacks(type, { ...data, generatedFrames: FRAMES_PER_MOCK_JOB }, error)
  }
}

function createMockedMossModel({ binding, files, extra = {} } = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS,
    files: files || { mossBackbone: BACKBONE, mossCodecDecoder: DECODER },
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

test('MOSS: explicit engine option routes to moss', (t) => {
  const model = createMockedMossModel()
  t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS)
  t.is(model._mossBackbonePath, BACKBONE)
  t.is(model._mossCodecDecoderPath, DECODER)
  t.absent(model._audio8LmPath, 'no audio8 path on moss')
  t.absent(model._t3ModelPath, 'no t3 path on moss')
})

test('MOSS: the backbone or the decoder alone routes to moss', (t) => {
  t.is(new TTSGgml({ files: { mossBackbone: BACKBONE } }).getEngineType(), TTSGgml.ENGINE_MOSS)
  t.is(new TTSGgml({ files: { mossCodecDecoder: DECODER } }).getEngineType(), TTSGgml.ENGINE_MOSS)
})

test('MOSS: the *Path file aliases normalize onto the same fields', (t) => {
  const model = new TTSGgml({
    files: {
      mossBackbonePath: BACKBONE,
      mossCodecDecoderPath: DECODER,
      mossCodecEncoderPath: ENCODER
    }
  })
  t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS)
  t.is(model._mossBackbonePath, BACKBONE)
  t.is(model._mossCodecDecoderPath, DECODER)
  t.is(model._mossCodecEncoderPath, ENCODER)
})

test('MOSS: modelDir auto-detect finds all three GGUFs', (t) => {
  withTempDir('tts-ggml-moss-detect', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-tts-delay-f16.gguf'), 'backbone')
    fs.writeFileSync(path.join(root, 'moss-codec-decoder-f16.gguf'), 'decoder')
    fs.writeFileSync(path.join(root, 'moss-codec-encoder-f16.gguf'), 'encoder')

    const model = new TTSGgml({ files: { modelDir: root } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS)
    t.is(model._mossBackbonePath, path.join(root, 'moss-tts-delay-f16.gguf'))
    t.is(model._mossCodecDecoderPath, path.join(root, 'moss-codec-decoder-f16.gguf'))
    t.is(model._mossCodecEncoderPath, path.join(root, 'moss-codec-encoder-f16.gguf'))
  })
})

test('MOSS: existing engines keep precedence in a shared modelDir', (t) => {
  withTempDir('tts-ggml-moss-precedence', (root, fs) => {
    fs.writeFileSync(path.join(root, 'audio8-lm-q8_0.gguf'), 'audio8')
    fs.writeFileSync(path.join(root, 'moss-tts-delay-f16.gguf'), 'moss')

    const model = new TTSGgml({ files: { modelDir: root } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_AUDIO8, 'audio8 still wins')
  })
})

test('MOSS: ttsParams shape forwards the full config surface', (t) => {
  const model = createMockedMossModel({
    files: { mossBackbone: BACKBONE, mossCodecDecoder: DECODER, mossCodecEncoder: ENCODER },
    extra: {
      referenceAudio: '/abs/voice.wav',
      seed: 7,
      threads: 2,
      streamChunkTokens: 25,
      config: { language: 'zh' }
    }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_MOSS)
  t.is(params.mossBackbonePath, BACKBONE)
  t.is(params.mossCodecDecoderPath, DECODER)
  t.is(params.mossCodecEncoderPath, ENCODER)
  t.is(params.referenceAudio, '/abs/voice.wav')
  t.is(params.language, 'zh')
  t.is(params.seed, 7)
  t.is(params.threads, 2)
  t.is(params.streamChunkTokens, 25)
  t.is(params.useGPU, false, 'useGPU defaults to false and forwards')
})

test('MOSS: a text-only config omits the encoder and the voice', (t) => {
  const params = createMockedMossModel()._buildTtsParams()
  t.absent(params.mossCodecEncoderPath)
  t.absent(params.referenceAudio)
  t.absent(params.streamChunkTokens)
  t.is(params.language, 'en', 'the documented default language is sent')
})

test('MOSS: cloning without the encoder GGUF throws', (t) => {
  t.exception(
    () => createMockedMossModel({ extra: { referenceAudio: '/abs/voice.wav' } }),
    /files\.mossCodecEncoder/
  )
})

test('MOSS: constructor rejects unsupported companions', (t) => {
  t.exception(
    () =>
      createMockedMossModel({
        files: {
          mossBackbone: BACKBONE,
          mossCodecDecoder: DECODER,
          lavasrEnhancer: '/abs/enh.gguf'
        }
      }),
    /not supported with the moss engine/,
    'enhancer throws'
  )
  t.exception(
    () => createMockedMossModel({ extra: { streamChunkTokens: 25, streamFirstChunkTokens: 5 } }),
    /streamFirstChunkTokens is not supported by the moss engine/,
    'a smaller first chunk throws'
  )
  t.exception(
    () => createMockedMossModel({ extra: { config: { outputSampleRate: 16000 } } }),
    /emits 24000 Hz only/,
    'a non-native output rate throws'
  )
  t.exception(
    () => createMockedMossModel({ extra: { temperature: 0.8 } }),
    /parler\/audio8-only/,
    'sampling knobs are not wired for moss'
  )
  t.exception(
    () => createMockedMossModel({ extra: { referenceText: 'Says this.' } }),
    /audio8-only/,
    'a transcript belongs to audio8'
  )
  t.exception(
    () => createMockedMossModel({ extra: { emotion: 'happy' } }),
    /moss engine does not support `emotion`/,
    'moss has no emotion control'
  )
})

test('MOSS: the native rate is accepted when named explicitly', (t) => {
  const model = createMockedMossModel({ extra: { config: { outputSampleRate: 24000 } } })
  t.is(model._buildTtsParams().outputSampleRate, 24000)
})

test('MOSS: GPU options forward to params', (t) => {
  const gpu = createMockedMossModel({ extra: { config: { useGPU: true } } })
  t.is(gpu._buildTtsParams().useGPU, true)

  const layers = createMockedMossModel({ extra: { nGpuLayers: 99 } })
  t.is(layers._buildTtsParams().nGpuLayers, 99)

  t.exception(
    () => createMockedMossModel({ extra: { config: { useGPU: false }, nGpuLayers: 99 } }),
    /conflicts/
  )
})

test('MOSS: per-call voice fields are rejected before queueing', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedMossModel({
    binding,
    files: { mossBackbone: BACKBONE, mossCodecDecoder: DECODER, mossCodecEncoder: ENCODER }
  })
  await model.load()
  await t.exception(
    model.run({ type: 'text', input: 'x', referenceAudio: '/abs/voice.wav' }),
    /audio8-only/
  )
  t.is(binding.jobs.length, 0, 'no job queued')
  await model.unload()
})

test('MOSS: a plain run sends only the text', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedMossModel({ binding })
  await model.load()
  const response = await model.run({ type: 'text', input: 'Hello.' })
  await response.await()
  t.is(binding.jobs.length, 1)
  t.alike(binding.jobs[0], { type: 'text', input: 'Hello.' })
  await model.unload()
})

test('MOSS: sentence streaming keeps tokensPerSecond on the codec frame grid', async (t) => {
  const text = 'First chunk sentence. Second chunk sentence.'
  const model = createMockedMossModel({ binding: new FrameReportingBinding() })
  await model.load()

  const response = await model.runStream(text, { maxChunkScalars: 20 })
  await response.onUpdate(() => {}).await()

  const stats = response.stats
  t.ok(stats.generatedFrames > 0, 'the frame count survives the aggregation')
  t.is(stats.tokensPerSecond, stats.generatedFrames / stats.totalTime)
  await model.unload()
})

test('MOSS: reload keeps paths and applies runtime config', async (t) => {
  const model = createMockedMossModel({ extra: { config: { language: 'en' } } })
  await model.load()
  await model.reload({ language: 'zh', useGPU: true })
  const params = model._buildTtsParams()
  t.is(params.language, 'zh')
  t.is(params.useGPU, true)
  t.is(params.mossBackbonePath, BACKBONE)
  await model.unload()
})

test('MOSS: reload refuses a new reference recording and keeps the old state', async (t) => {
  const model = createMockedMossModel({
    files: { mossBackbone: BACKBONE, mossCodecDecoder: DECODER, mossCodecEncoder: ENCODER },
    extra: { referenceAudio: '/abs/voice.wav', config: { language: 'en' } }
  })
  await model.load()
  await t.exception(
    model.reload({ language: 'zh', referenceAudio: '/abs/other.wav' }),
    /encodes referenceAudio once per instance/
  )
  const params = model._buildTtsParams()
  t.is(params.referenceAudio, '/abs/voice.wav')
  t.is(params.language, 'en', 'the refused reload rolled back')
  await model.unload()
})

test('MOSS: reload refuses a non-native output rate and rolls back', async (t) => {
  const model = createMockedMossModel()
  await model.load()
  await t.exception(model.reload({ outputSampleRate: 16000 }), /emits 24000 Hz only/)
  t.absent(model._buildTtsParams().outputSampleRate)
  await model.unload()
})
