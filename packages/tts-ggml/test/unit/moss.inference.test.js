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

const TTSD_BACKBONE = './models/moss-ttsd-f16.gguf'
const SPEAKER_ONE = '/abs/speaker-1.wav'
const SPEAKER_TWO = '/abs/speaker-2.wav'
const DURATION_TOKENS = 38
const RELOADED_DURATION_TOKENS = 50
const MAX_DURATION_TOKENS = 2015
const CLONING_FILES = {
  mossBackbone: BACKBONE,
  mossCodecDecoder: DECODER,
  mossCodecEncoder: ENCODER
}

function createDialogueModel(extra = {}) {
  return createMockedMossModel({
    files: { mossBackbone: TTSD_BACKBONE, mossCodecDecoder: DECODER, mossCodecEncoder: ENCODER },
    extra: { dialogueReferences: [SPEAKER_ONE, SPEAKER_TWO], ...extra }
  })
}

test('MOSS: durationTokens reaches the native params', (t) => {
  const model = createMockedMossModel({ extra: { durationTokens: DURATION_TOKENS } })
  t.is(model._buildTtsParams().durationTokens, DURATION_TOKENS)
  t.absent(createMockedMossModel()._buildTtsParams().durationTokens, 'unset stays free length')
})

test('MOSS: durationTokens must be a non-negative integer', (t) => {
  for (const bad of [-1, 1.5, Number.NaN, MAX_DURATION_TOKENS + 1]) {
    t.exception(
      () => createMockedMossModel({ extra: { durationTokens: bad } }),
      /durationTokens must be an integer from 0 to 2015/,
      `durationTokens ${bad} is rejected`
    )
  }
  t.is(createMockedMossModel({ extra: { durationTokens: 0 } })._buildTtsParams().durationTokens, 0)
})

test('MOSS: durationTokens is reloadable and a refused value rolls back', async (t) => {
  const model = createMockedMossModel({ extra: { durationTokens: DURATION_TOKENS } })
  await model.load()
  await model.reload({ durationTokens: RELOADED_DURATION_TOKENS })
  t.is(
    model._buildTtsParams().durationTokens,
    RELOADED_DURATION_TOKENS,
    'reload updates the target length'
  )
  await t.exception(
    model.reload({ durationTokens: -3, language: 'zh' }),
    /durationTokens must be an integer from 0 to 2015/
  )
  const params = model._buildTtsParams()
  t.is(
    params.durationTokens,
    RELOADED_DURATION_TOKENS,
    'the refused reload kept the previous length'
  )
  t.is(params.language, 'en', 'and the rest of the configuration')
  await model.unload()
})

test('MOSS: dialogueReferences reach the native params as a copy', (t) => {
  const references = [SPEAKER_ONE, SPEAKER_TWO]
  const model = createDialogueModel({ dialogueReferences: references })
  references.push('/abs/late.wav')
  const params = model._buildTtsParams()
  t.alike(params.dialogueReferences, [SPEAKER_ONE, SPEAKER_TWO])
  t.is(params.mossBackbonePath, TTSD_BACKBONE)
  t.absent(params.referenceAudio)
})

test('MOSS: dialogueReferences need the codec encoder and exclude referenceAudio', (t) => {
  t.exception(
    () =>
      createMockedMossModel({
        extra: { dialogueReferences: [SPEAKER_ONE, SPEAKER_TWO] }
      }),
    /dialogue synthesis with the moss engine needs the codec encoder/
  )
  t.exception(
    () => createDialogueModel({ referenceAudio: '/abs/voice.wav' }),
    /referenceAudio and dialogueReferences are exclusive/
  )
})

test('MOSS: malformed dialogueReferences are rejected', (t) => {
  for (const bad of [[], [SPEAKER_ONE, ''], [SPEAKER_ONE, 7], SPEAKER_ONE]) {
    t.exception(
      () => createDialogueModel({ dialogueReferences: bad }),
      /dialogueReferences must be a non-empty array of WAV paths/,
      `dialogueReferences ${JSON.stringify(bad)} is rejected`
    )
  }
  const unset = createDialogueModel({ dialogueReferences: null })
  t.absent(unset._buildTtsParams().dialogueReferences, 'null means no dialogue references')
})

test('MOSS: moss-only options on other engines throw', (t) => {
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_AUDIO8,
        files: { audio8Lm: './models/audio8-lm-q8_0.gguf' },
        durationTokens: DURATION_TOKENS
      }),
    /durationTokens are moss-only options/
  )
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_SUPERTONIC,
        files: { supertonicModel: './models/supertonic.gguf' },
        dialogueReferences: [SPEAKER_ONE]
      }),
    /dialogueReferences are moss-only options/
  )
})

test('MOSS: reload refuses new dialogue references and keeps the old state', async (t) => {
  const model = createDialogueModel()
  await model.load()
  await t.exception(
    model.reload({ dialogueReferences: [SPEAKER_TWO], language: 'zh' }),
    /encodes dialogueReferences once per instance/
  )
  const params = model._buildTtsParams()
  t.alike(params.dialogueReferences, [SPEAKER_ONE, SPEAKER_TWO])
  t.is(params.language, 'en', 'the refused reload rolled back')
  await model.unload()
})

test('MOSS: modelDir picks the TTSD backbone for dialogue and MOSS-TTS otherwise', (t) => {
  withTempDir('tts-ggml-moss-ttsd', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-tts-delay-f16.gguf'), 'tts')
    fs.writeFileSync(path.join(root, 'moss-ttsd-f16.gguf'), 'ttsd')
    fs.writeFileSync(path.join(root, 'moss-codec-decoder-f16.gguf'), 'decoder')
    fs.writeFileSync(path.join(root, 'moss-codec-encoder-f16.gguf'), 'encoder')

    const plain = new TTSGgml({ files: { modelDir: root } })
    t.is(plain._mossBackbonePath, path.join(root, 'moss-tts-delay-f16.gguf'))

    const dialogue = new TTSGgml({
      engine: TTSGgml.ENGINE_MOSS,
      files: { modelDir: root },
      dialogueReferences: [SPEAKER_ONE, SPEAKER_TWO]
    })
    t.is(dialogue._mossBackbonePath, path.join(root, 'moss-ttsd-f16.gguf'))
  })
})

test('MOSS: a modelDir holding only the TTSD backbone routes to moss', (t) => {
  withTempDir('tts-ggml-moss-ttsd-only', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-ttsd-f16.gguf'), 'ttsd')
    fs.writeFileSync(path.join(root, 'moss-codec-decoder-f16.gguf'), 'decoder')
    const model = new TTSGgml({ files: { modelDir: root } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS)
    t.is(model._mossBackbonePath, path.join(root, 'moss-ttsd-f16.gguf'))

    fs.writeFileSync(path.join(root, 'flow-lm.gguf'), 'pocket')
    const sharedModel = new TTSGgml({ files: { modelDir: root } })
    t.is(sharedModel.getEngineType(), TTSGgml.ENGINE_MOSS)
  })
})

test('MOSS: backendsDir reaches the native params', (t) => {
  const model = createMockedMossModel({
    files: CLONING_FILES,
    extra: { backendsDir: '/opt/backends' }
  })
  t.is(model._buildTtsParams().backendsDir, '/opt/backends')
})

test('MOSS: durationTokens accepts the largest target the engine budget fits', (t) => {
  const model = createMockedMossModel({ extra: { durationTokens: MAX_DURATION_TOKENS } })
  t.is(model._buildTtsParams().durationTokens, MAX_DURATION_TOKENS)
})

test('MOSS: a null durationTokens means free length', async (t) => {
  const model = createMockedMossModel({ extra: { durationTokens: null } })
  t.absent(model._buildTtsParams().durationTokens, 'null at construction is unset')
  await model.load()
  await model.reload({ durationTokens: DURATION_TOKENS })
  await model.reload({ durationTokens: null })
  t.absent(model._buildTtsParams().durationTokens, 'reload with null clears the target')
  await model.unload()
})

test('MOSS: an over-budget reload is refused before the instance is rebuilt', async (t) => {
  const model = createMockedMossModel({ extra: { durationTokens: DURATION_TOKENS } })
  await model.load()
  const addon = model.addon
  await t.exception(
    model.reload({ durationTokens: MAX_DURATION_TOKENS + 1 }),
    /durationTokens must be an integer from 0 to 2015/
  )
  t.is(model.addon, addon, 'the working instance was kept')
  t.is(model._buildTtsParams().durationTokens, DURATION_TOKENS)
  await model.unload()
})

test('MOSS: dialogue refuses sentence streaming', async (t) => {
  const model = createDialogueModel()
  await model.load()
  await t.exception(
    model.runStream('[S1] Hi. [S2] Hello.'),
    /MOSS dialogue cannot be split into sentences/
  )
  await t.exception(
    model.run({ input: '[S1] Hi. [S2] Hello.', streamOutput: true }),
    /MOSS dialogue cannot be split into sentences/
  )
  await t.exception(
    model.runStreaming(['[S1] Hi.', '[S2] Hello.']),
    /MOSS dialogue cannot be split into sentences/
  )
  await model.unload()
})

test('MOSS: dialogue with a modelDir needs the TTSD backbone', (t) => {
  withTempDir('tts-ggml-moss-no-ttsd', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-tts-delay-f16.gguf'), 'tts')
    fs.writeFileSync(path.join(root, 'moss-codec-decoder-f16.gguf'), 'decoder')
    fs.writeFileSync(path.join(root, 'moss-codec-encoder-f16.gguf'), 'encoder')
    t.exception(
      () =>
        new TTSGgml({
          engine: TTSGgml.ENGINE_MOSS,
          files: { modelDir: root },
          dialogueReferences: [SPEAKER_ONE, SPEAKER_TWO]
        }),
      /needs the MOSS-TTSD backbone/
    )
  })
})

test('MOSS: reload refuses an empty referenceAudio instead of ignoring it', async (t) => {
  const model = createMockedMossModel({
    files: CLONING_FILES,
    extra: { referenceAudio: '/abs/voice.wav' }
  })
  await model.load()
  await t.exception(
    model.reload({ referenceAudio: '' }),
    /encodes referenceAudio once per instance/
  )
  t.is(model._buildTtsParams().referenceAudio, '/abs/voice.wav')
  await model.unload()
})
