'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

const LM = './models/audio8-lm-q8_0.gguf'
const DECODER = './models/audio8-codec-decoder-q8_0.gguf'
const ENCODER = './models/audio8-codec-encoder-q8_0.gguf'

/** MockedBinding that records every runJob payload (per-call field checks). */
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

const FRAMES_PER_MOCK_JOB = 7

/** MockedBinding that reports codec frames the way the audio8 engine does. */
class FrameReportingBinding extends MockedBinding {
  _callCallbacks(type, data, error) {
    if (type !== 'RuntimeStats') return super._callCallbacks(type, data, error)
    return super._callCallbacks(type, { ...data, generatedFrames: FRAMES_PER_MOCK_JOB }, error)
  }
}

function createMockedAudio8Model({
  onOutput = () => {},
  binding,
  files,
  exclusiveRun = false,
  extra = {}
} = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_AUDIO8,
    files: files || { audio8Lm: LM, audio8CodecDecoder: DECODER },
    opts: { stats: true },
    exclusiveRun,
    ...extra
  })

  model._createAddon = (configurationParams, outputCb) => {
    const _binding = binding || new MockedBinding()
    const addon = new TTSInterface(_binding, configurationParams, outputCb)
    if (_binding.setBaseInferenceCallback) {
      _binding.setBaseInferenceCallback(onOutput)
    }
    return addon
  }
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

test('Audio8: explicit engine option routes to audio8', (t) => {
  const model = createMockedAudio8Model()
  t.is(model.getEngineType(), TTSGgml.ENGINE_AUDIO8, 'engine: audio8 detected')
  t.is(model._audio8LmPath, LM)
  t.is(model._audio8CodecDecoderPath, DECODER)
  t.absent(model._t3ModelPath, 'no t3 path on audio8')
  t.absent(model._parlerModelPath, 'no parler path on audio8')
  t.absent(model._supertonicModelPath, 'no supertonic path on audio8')
})

test('Audio8: audio8Lm file path alone routes to audio8', (t) => {
  const model = new TTSGgml({ files: { audio8Lm: LM } })
  t.is(model.getEngineType(), TTSGgml.ENGINE_AUDIO8, 'audio8Lm file detected')
})

test('Audio8: the codec decoder alone routes to audio8', (t) => {
  const model = new TTSGgml({ files: { audio8CodecDecoder: DECODER } })
  t.is(model.getEngineType(), TTSGgml.ENGINE_AUDIO8, 'audio8CodecDecoder file detected')
  t.is(model._audio8CodecDecoderPath, DECODER)
})

test('Audio8: the *Path file aliases detect and normalize the same way', (t) => {
  const fromLm = new TTSGgml({ files: { audio8LmPath: LM } })
  t.is(fromLm.getEngineType(), TTSGgml.ENGINE_AUDIO8, 'audio8LmPath detected')
  t.is(fromLm._audio8LmPath, LM, 'the alias normalizes onto the same field')

  const fromDecoder = new TTSGgml({ files: { audio8CodecDecoderPath: DECODER } })
  t.is(fromDecoder.getEngineType(), TTSGgml.ENGINE_AUDIO8, 'audio8CodecDecoderPath detected')
  t.is(fromDecoder._audio8CodecDecoderPath, DECODER, 'the alias normalizes onto the same field')

  const full = new TTSGgml({
    files: {
      audio8LmPath: LM,
      audio8CodecDecoderPath: DECODER,
      audio8CodecEncoderPath: ENCODER
    }
  })
  t.is(full._audio8CodecEncoderPath, ENCODER, 'the encoder alias normalizes too')
})

test('Audio8: modelDir auto-detect picks each half at the best quant tier', (t) => {
  withTempDir('tts-ggml-audio8-detect', (root, fs) => {
    fs.writeFileSync(path.join(root, 'audio8-lm-f32.gguf'), 'lm-f32')
    fs.writeFileSync(path.join(root, 'audio8-lm-q8_0.gguf'), 'lm-q8')
    fs.writeFileSync(path.join(root, 'audio8-codec-decoder-f16.gguf'), 'dec-f16')
    fs.writeFileSync(path.join(root, 'audio8-codec-encoder-q8_0.gguf'), 'enc-q8')

    const model = new TTSGgml({ files: { modelDir: root } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_AUDIO8, 'modelDir with audio8 GGUFs detected')
    t.is(model._audio8LmPath, path.join(root, 'audio8-lm-q8_0.gguf'), 'q8_0 beats f32')
    t.is(
      model._audio8CodecDecoderPath,
      path.join(root, 'audio8-codec-decoder-f16.gguf'),
      'the only decoder tier present is used'
    )
    t.is(
      model._audio8CodecEncoderPath,
      path.join(root, 'audio8-codec-encoder-q8_0.gguf'),
      'the encoder is picked up when present'
    )
  })
})

test('Audio8: existing engines keep precedence in a shared modelDir', (t) => {
  withTempDir('tts-ggml-audio8-precedence', (root, fs) => {
    fs.writeFileSync(path.join(root, 'supertonic.gguf'), 'super-marker')
    fs.writeFileSync(path.join(root, 'audio8-lm-q8_0.gguf'), 'audio8-marker')

    const model = new TTSGgml({ files: { modelDir: root } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_SUPERTONIC, 'supertonic still wins')
  })
})

test('Audio8: ttsParams shape forwards the full config surface', (t) => {
  const model = createMockedAudio8Model({
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER },
    extra: {
      referenceAudio: '/abs/voice.wav',
      referenceText: 'What the recording says.',
      greedy: false,
      seed: 7,
      threads: 2,
      temperature: 0.8,
      topK: 40,
      topP: 0.95,
      maxFrames: 256,
      config: { outputSampleRate: 16000 }
    }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_AUDIO8)
  t.is(params.audio8LmPath, LM)
  t.is(params.audio8CodecDecoderPath, DECODER)
  t.is(params.audio8CodecEncoderPath, ENCODER)
  t.is(params.referenceAudio, '/abs/voice.wav')
  t.is(params.referenceText, 'What the recording says.')
  t.is(params.greedy, false)
  t.is(params.seed, 7)
  t.is(params.threads, 2)
  t.is(params.temperature, 0.8)
  t.is(params.topK, 40)
  t.is(params.topP, 0.95)
  t.is(params.maxFrames, 256)
  t.is(params.outputSampleRate, 16000)
  t.is(params.useGPU, false, 'useGPU defaults to false (opt-in) and forwards')
  t.absent(params.language, 'no language key (audio8 reads it from the prompt)')
})

test('Audio8: a text-only config omits the encoder and the voice', (t) => {
  const params = createMockedAudio8Model()._buildTtsParams()
  t.absent(params.audio8CodecEncoderPath, 'no encoder key when none is configured')
  t.absent(params.referenceAudio, 'no reference audio key')
  t.absent(params.referenceText, 'no reference text key')
})

test('Audio8: constructor guards reject a half-specified voice', (t) => {
  t.exception(
    () =>
      createMockedAudio8Model({
        files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER },
        extra: { referenceAudio: '/abs/voice.wav' }
      }),
    /referenceAudio needs a referenceText/,
    'a recording without its transcript throws'
  )
  t.exception(
    () => createMockedAudio8Model({ extra: { referenceText: 'Orphan transcript.' } }),
    /referenceText needs a referenceAudio/,
    'a transcript with nothing to attach to throws'
  )
  t.exception(
    () =>
      createMockedAudio8Model({
        extra: { referenceAudio: '/abs/voice.wav', referenceText: 'Says this.' }
      }),
    /codec encoder/,
    'cloning without the encoder GGUF throws'
  )
})

test('Audio8: constructor rejects unsupported companions', (t) => {
  t.exception(
    () =>
      createMockedAudio8Model({
        files: { audio8Lm: LM, audio8CodecDecoder: DECODER, lavasrEnhancer: '/abs/enh.gguf' }
      }),
    /not supported with the audio8 engine/,
    'enhancer throws'
  )
  t.exception(
    () => createMockedAudio8Model({ extra: { streamChunkTokens: 40 } }),
    /not supported by the audio8 engine/,
    'native chunk streaming throws'
  )
})

test('Audio8: audio8-only options on other engines throw', (t) => {
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_SUPERTONIC,
        files: { supertonicModel: './models/supertonic.gguf' },
        referenceText: 'Says this.'
      }),
    /audio8-only/,
    'referenceText on supertonic throws'
  )
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_CHATTERBOX,
        files: { t3Model: './models/t3.gguf', s3genModel: './models/s3gen.gguf' },
        greedy: true
      }),
    /audio8-only/,
    'greedy on chatterbox throws'
  )
})

test('Audio8: GPU options forward to params', (t) => {
  const gpu = createMockedAudio8Model({ extra: { config: { useGPU: true } } })
  t.is(gpu._buildTtsParams().useGPU, true, 'useGPU:true forwards to params')

  const layers = createMockedAudio8Model({ extra: { nGpuLayers: 99 } })
  t.is(layers._buildTtsParams().nGpuLayers, 99, 'nGpuLayers forwards to params')

  t.exception(
    () => createMockedAudio8Model({ extra: { config: { useGPU: false }, nGpuLayers: 99 } }),
    /conflicts/,
    'useGPU:false + nGpuLayers:99 conflict rejects'
  )
})

test('Audio8: per-call voice fields land on the jobData', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedAudio8Model({
    binding,
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER },
    extra: {
      referenceAudio: '/abs/configured.wav',
      referenceText: 'The configured transcript.'
    }
  })
  await model.load()

  const r1 = await model.run({
    type: 'text',
    input: 'A different speaker.',
    referenceAudio: '/abs/other.wav',
    referenceText: 'What the other recording says.'
  })
  await r1.await()
  t.is(binding.jobs.length, 1, 'one job ran')
  t.is(binding.jobs[0].referenceAudio, '/abs/other.wav', 'per-call audio rides on jobData')
  t.is(binding.jobs[0].referenceText, 'What the other recording says.')

  const r2 = await model.run({
    type: 'text',
    input: 'Same speaker, corrected transcript.',
    referenceText: 'A corrected transcript.'
  })
  await r2.await()
  t.is(binding.jobs[1].referenceText, 'A corrected transcript.')
  t.absent(binding.jobs[1].referenceAudio, 'the configured recording is not re-sent')

  const r3 = await model.run({ type: 'text', input: 'Plain run.' })
  await r3.await()
  t.absent(binding.jobs[2].referenceAudio, 'no leftover fields on a plain run')
  t.absent(binding.jobs[2].referenceText, 'no leftover transcript on a plain run')

  await model.unload()
})

test('Audio8: a per-call recording without a transcript rejects before queueing', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedAudio8Model({
    binding,
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER }
  })
  await model.load()

  await t.exception(
    model.run({ type: 'text', input: 'x', referenceAudio: '/abs/voice.wav' }),
    /referenceAudio needs a referenceText/,
    'per-call half-specified voice rejects'
  )
  t.is(binding.jobs.length, 0, 'no job queued on conflict')
  await model.unload()
})

test('Audio8: a per-call recording cannot inherit the configured transcript', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedAudio8Model({
    binding,
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER },
    extra: {
      referenceAudio: '/abs/configured.wav',
      referenceText: 'The configured transcript.'
    }
  })
  await model.load()

  // The configured transcript describes the configured recording, so it cannot
  // stand in for a different one. The native resolveVoice drops it for exactly
  // this reason; rejecting here keeps the two layers agreeing.
  await t.exception(
    model.run({ type: 'text', input: 'x', referenceAudio: '/abs/other.wav' }),
    /referenceAudio needs a referenceText/,
    'a new recording without its own transcript rejects'
  )
  t.is(binding.jobs.length, 0, 'no job queued on conflict')

  await model.unload()
})

test('Audio8: per-call voice fields on other engines throw', async (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: './models/supertonic.gguf' },
    voice: 'F1',
    config: { language: 'en', useGPU: false }
  })
  model._createAddon = (configurationParams, outputCb) =>
    new TTSInterface(new MockedBinding(), configurationParams, outputCb)
  await model.load()
  await t.exception(
    model.run({ type: 'text', input: 'x', referenceText: 'Says this.' }),
    /audio8-only/,
    'per-call referenceText on supertonic rejects'
  )
  await model.unload()
})

test('Audio8: runStream pins the per-call voice on every chunk jobData', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedAudio8Model({
    binding,
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER }
  })
  await model.load()

  const text = 'First chunk sentence. Second chunk sentence.'
  const r = await model.runStream(text, {
    maxChunkScalars: 20,
    referenceAudio: '/abs/voice.wav',
    referenceText: 'What the recording says.'
  })
  await r.onUpdate(() => {}).await()

  t.ok(binding.jobs.length >= 2, `stream ran multiple jobs (got ${binding.jobs.length})`)
  for (const job of binding.jobs) {
    t.is(job.referenceAudio, '/abs/voice.wav', 'every chunk carries the pinned recording')
    t.is(job.referenceText, 'What the recording says.', 'and its transcript')
  }
  await model.unload()
})

test('Audio8: runStreaming pins the per-call voice on every flushed job', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedAudio8Model({
    binding,
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER }
  })
  await model.load()

  async function* tokens() {
    yield 'First streamed sentence. '
    yield 'Second streamed sentence.'
  }
  const r = await model.runStreaming(tokens(), {
    accumulateSentences: false,
    referenceAudio: '/abs/voice.wav',
    referenceText: 'What the recording says.'
  })
  await r.onUpdate(() => {}).await()

  t.ok(binding.jobs.length >= 2, `streaming flushed multiple jobs (got ${binding.jobs.length})`)
  for (const job of binding.jobs) {
    t.is(job.referenceAudio, '/abs/voice.wav', 'every flushed job carries the recording')
    t.is(job.referenceText, 'What the recording says.', 'and its transcript')
  }
  await model.unload()
})

test('Audio8: runStreaming rejects an incomplete voice before dispatching', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedAudio8Model({
    binding,
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER }
  })
  await model.load()

  async function* tokens() {
    yield 'This should never reach the engine.'
  }
  await t.exception(
    model.runStreaming(tokens(), { referenceAudio: '/abs/voice.wav' }),
    /referenceText/,
    'a recording without a transcript is refused'
  )
  t.is(binding.jobs.length, 0, 'nothing was dispatched')
  await model.unload()
})

test('Audio8: streaming keeps tokensPerSecond on the codec frame grid', async (t) => {
  const text = 'First chunk sentence. Second chunk sentence.'
  const model = createMockedAudio8Model({ binding: new FrameReportingBinding() })
  await model.load()

  const r = await model.runStream(text, { maxChunkScalars: 20 })
  await r.onUpdate(() => {}).await()

  const stats = r.stats
  t.ok(stats.generatedFrames > 0, 'the frame count survives the aggregation')
  t.is(
    stats.tokensPerSecond,
    stats.generatedFrames / stats.totalTime,
    'streaming paces on frames, the same unit run() reports'
  )
  t.not(
    stats.tokensPerSecond,
    text.replace(/\s+$/, '').length / stats.totalTime,
    'and not on characters, which is what the text-paced engines count'
  )
  await model.unload()
})

test('Audio8: reload merges the voice and the sampling knobs', async (t) => {
  const model = createMockedAudio8Model({
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER },
    extra: { temperature: 0.7, maxFrames: 128 }
  })
  await model.load()

  await model.reload({
    temperature: 0.9,
    maxFrames: 256,
    greedy: false,
    referenceAudio: '/abs/voice.wav',
    referenceText: 'What the recording says.'
  })
  const params = model._buildTtsParams()
  t.is(params.temperature, 0.9, 'reload updates temperature')
  t.is(params.maxFrames, 256, 'reload updates maxFrames')
  t.is(params.referenceAudio, '/abs/voice.wav', 'reload enrols a voice')
  t.is(params.referenceText, 'What the recording says.')

  await t.exception(
    model.reload({ referenceText: '' }),
    /referenceText/,
    'reload cannot drop half of the voice'
  )
  await model.unload()
})

function clonedAudio8Model() {
  return createMockedAudio8Model({
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER },
    extra: { referenceAudio: '/abs/alice.wav', referenceText: 'Alice says this.' }
  })
}

test('Audio8: reload will not put a new recording on the old transcript', async (t) => {
  const model = clonedAudio8Model()
  await model.load()

  await t.exception(
    model.reload({ referenceAudio: '/abs/bob.wav' }),
    /referenceText/,
    'a new recording has to bring its own transcript'
  )

  const params = model._buildTtsParams()
  t.is(params.referenceAudio, '/abs/alice.wav', 'the refused reload kept the old recording')
  t.is(params.referenceText, 'Alice says this.', 'and the transcript that goes with it')
  await model.unload()
})

test('Audio8: a refused reload leaves the voice where it was', async (t) => {
  const model = clonedAudio8Model()
  await model.load()

  await t.exception(
    model.reload({ referenceText: '' }),
    /referenceText/,
    'an empty transcript is refused'
  )

  const params = model._buildTtsParams()
  t.is(params.referenceText, 'Alice says this.', 'the transcript is not left blanked')
  t.is(params.referenceAudio, '/abs/alice.wav', 'and the recording is untouched')
  await model.unload()
})

test('Audio8: a sampling value native would refuse rolls the reload back', async (t) => {
  const model = createMockedAudio8Model({
    files: { audio8Lm: LM, audio8CodecDecoder: DECODER, audio8CodecEncoder: ENCODER },
    extra: {
      temperature: 0.7,
      topP: 0.9,
      referenceAudio: '/abs/alice.wav',
      referenceText: 'Alice says this.'
    }
  })
  await model.load()

  await t.exception(
    model.reload({ temperature: NaN, referenceText: 'Alice really says this.' }),
    /temperature must be a finite number/,
    'NaN is refused rather than carried into the sampler'
  )

  const params = model._buildTtsParams()
  t.is(params.temperature, 0.7, 'the old temperature is still in place')
  t.is(params.referenceText, 'Alice says this.', 'and the voice did not move either')
  await model.unload()
})

test('Audio8: reload refuses sampling values outside the native bounds', async (t) => {
  const model = createMockedAudio8Model({ extra: { temperature: 0.7, topP: 0.9, topK: 40 } })
  await model.load()

  await t.exception(
    model.reload({ topP: 0 }),
    /topP must be in \(0, 1\]/,
    'topP has to be above zero'
  )
  await t.exception(
    model.reload({ temperature: -1 }),
    /temperature must be >= 0/,
    'temperature cannot be negative'
  )
  await t.exception(model.reload({ topK: -5 }), /topK must be >= 0/, 'topK cannot be negative')

  const params = model._buildTtsParams()
  t.is(params.topP, 0.9, 'topP kept its value')
  t.is(params.temperature, 0.7, 'temperature kept its value')
  t.is(params.topK, 40, 'topK kept its value')
  await model.unload()
})

test('Audio8: reload can correct the transcript on its own', async (t) => {
  const model = clonedAudio8Model()
  await model.load()

  await model.reload({ referenceText: 'Alice really says this.' })

  const params = model._buildTtsParams()
  t.is(params.referenceAudio, '/abs/alice.wav', 'the recording stays')
  t.is(params.referenceText, 'Alice really says this.', 'the transcript is corrected')
  await model.unload()
})
