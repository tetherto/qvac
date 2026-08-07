'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

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

function createMockedParlerModel({
  onOutput = () => {},
  binding,
  files,
  exclusiveRun = false,
  extra = {}
} = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_PARLER,
    files: files || { parlerModel: './models/parler-mini-v1-q8_0.gguf' },
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

test('Parler: explicit engine option routes to parler', (t) => {
  const model = createMockedParlerModel()
  t.is(model.getEngineType(), TTSGgml.ENGINE_PARLER, 'engine: parler detected')
  t.is(model._parlerModelPath, './models/parler-mini-v1-q8_0.gguf')
  t.absent(model._t3ModelPath, 'no t3 path on parler')
  t.absent(model._s3genModelPath, 'no s3gen path on parler')
  t.absent(model._supertonicModelPath, 'no supertonic path on parler')
})

test('Parler: parlerModel file path alone routes to parler engine', (t) => {
  const model = new TTSGgml({ files: { parlerModel: './models/parler-indic-q8_0.gguf' } })
  t.is(model.getEngineType(), TTSGgml.ENGINE_PARLER, 'parlerModel file detected')
})

test('Parler: invalid engine error message lists parler', (t) => {
  t.exception(
    () => new TTSGgml({ engine: 'parakeet' }),
    /'chatterbox', 'supertonic', 'cosyvoice3' or 'parler'/,
    'engine validation message includes parler'
  )
})

test('Parler: modelDir auto-detect ranks variant then quant tier', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const tmpRoot = path.join(os.tmpdir(), 'tts-ggml-parler-detect-' + Date.now())
  try {
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'parler-indic-q8_0.gguf'), 'indic-marker')
    fs.writeFileSync(path.join(tmpRoot, 'parler-mini-v1-f16.gguf'), 'mini-f16-marker')
    fs.writeFileSync(path.join(tmpRoot, 'parler-mini-v1-q8_0.gguf'), 'mini-q8-marker')
    fs.writeFileSync(path.join(tmpRoot, 'parler.gguf'), 'ambiguous-marker')

    const model = new TTSGgml({ files: { modelDir: tmpRoot } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_PARLER, 'modelDir with parler GGUFs detected')
    t.is(
      model._parlerModelPath,
      path.join(tmpRoot, 'parler-mini-v1-q8_0.gguf'),
      'mini beats indic; q8_0 beats f16; bare parler.gguf ignored'
    )
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch (_e) {}
  }
})

test('Parler: chatterbox/supertonic files win over parler in a shared modelDir', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const tmpRoot = path.join(os.tmpdir(), 'tts-ggml-parler-precedence-' + Date.now())
  try {
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'supertonic.gguf'), 'super-marker')
    fs.writeFileSync(path.join(tmpRoot, 'parler-mini-v1-q8_0.gguf'), 'parler-marker')

    const model = new TTSGgml({ files: { modelDir: tmpRoot } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_SUPERTONIC, 'existing engines keep precedence')
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch (_e) {}
  }
})

test('Parler: ttsParams shape forwards the full config surface', (t) => {
  const model = createMockedParlerModel({
    extra: {
      voice: 'Rohit',
      emotion: 'happy',
      pitch: 'high',
      pace: 'slow',
      expressivity: 'expressive',
      noise: 'clear',
      reverb: 'close',
      quality: 'very high',
      seed: 7,
      threads: 2,
      temperature: 0.9,
      topK: 40,
      topP: 0.95,
      maxFrames: 860,
      minNewTokens: 10,
      normalizeNumbers: false,
      config: { outputSampleRate: 16000 }
    }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_PARLER)
  t.is(params.parlerModelPath, './models/parler-mini-v1-q8_0.gguf')
  t.is(params.voice, 'Rohit')
  t.is(params.emotion, 'happy')
  t.is(params.pitch, 'high')
  t.is(params.pace, 'slow')
  t.is(params.expressivity, 'expressive')
  t.is(params.noise, 'clear')
  t.is(params.reverb, 'close')
  t.is(params.quality, 'very high')
  t.is(params.seed, 7)
  t.is(params.threads, 2)
  t.is(params.temperature, 0.9)
  t.is(params.topK, 40)
  t.is(params.topP, 0.95)
  t.is(params.maxFrames, 860)
  t.is(params.minNewTokens, 10)
  t.is(params.normalizeNumbers, false)
  t.is(params.outputSampleRate, 16000)
  t.absent(params.description, 'no description key when using template fields')
  t.is(params.useGPU, false, 'useGPU defaults to false (opt-in) and forwards')
  t.absent(params.language, 'no language key (parler detects it from the prompt script)')
})

test('Parler: description forwards; voiceDescription aliases', (t) => {
  const model = createMockedParlerModel({
    extra: { description: 'A calm female voice, very clear audio.' }
  })
  t.is(model._buildTtsParams().description, 'A calm female voice, very clear audio.')

  const aliased = createMockedParlerModel({
    extra: { voiceDescription: 'Aliased description.' }
  })
  t.is(aliased._buildTtsParams().description, 'Aliased description.')
})

test('Parler: constructor guards reject conflicting / unsupported options', (t) => {
  t.exception(
    () => createMockedParlerModel({ extra: { description: 'A voice.', emotion: 'happy' } }),
    /mutually exclusive/,
    'description + template field throws'
  )
  t.exception(
    () =>
      createMockedParlerModel({
        files: {
          parlerModel: './models/parler-mini-v1-q8_0.gguf',
          lavasrDenoiser: '/abs/den.gguf'
        },
        extra: { streamChunkTokens: 40 }
      }),
    /denoiser is not yet supported with native chunk streaming/,
    'denoiser + native chunk streaming throws'
  )
})

test('Parler: LavaSR enhancer forwards to params', (t) => {
  const model = createMockedParlerModel({
    files: {
      parlerModel: './models/parler-mini-v1-q8_0.gguf',
      lavasrEnhancer: '/abs/enh.gguf'
    }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_PARLER)
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf', 'enhancer path reaches the addon')
  t.absent(params.lavasrDenoiserPath, 'no denoiser key when only the enhancer is set')
})

test('Parler: LavaSR denoiser forwards to params on the batch path', (t) => {
  const model = createMockedParlerModel({
    files: {
      parlerModel: './models/parler-mini-v1-q8_0.gguf',
      lavasrEnhancer: '/abs/enh.gguf',
      lavasrDenoiser: '/abs/den.gguf'
    }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf')
  t.is(params.lavasrDenoiserPath, '/abs/den.gguf', 'denoiser path reaches the addon')
})

test('Parler: enhancer combines with native chunk streaming', (t) => {
  const model = createMockedParlerModel({
    files: {
      parlerModel: './models/parler-mini-v1-q8_0.gguf',
      lavasrEnhancer: '/abs/enh.gguf'
    },
    extra: { streamChunkTokens: 43 }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf')
  t.is(params.streamChunkTokens, 43, 'streaming + enhancer is accepted')
})

test('Parler: enhancer accepts a non-native outputSampleRate while streaming', (t) => {
  // StreamingEnhancer resamples inside its overlap windows, so the requested
  // rate survives chunk seams; the addon enforces the same rule in C++.
  const model = createMockedParlerModel({
    files: {
      parlerModel: './models/parler-mini-v1-q8_0.gguf',
      lavasrEnhancer: '/abs/enh.gguf'
    },
    extra: { streamChunkTokens: 43, config: { outputSampleRate: 24000 } }
  })
  const params = model._buildTtsParams()
  t.is(params.outputSampleRate, 24000)
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf')
})

test('Parler: streamChunkTokens / streamFirstChunkTokens forward to params', (t) => {
  const model = createMockedParlerModel({
    extra: { streamChunkTokens: 43, streamFirstChunkTokens: 20 }
  })
  const params = model._buildTtsParams()
  t.is(params.streamChunkTokens, 43, 'streamChunkTokens forwarded to params')
  t.is(params.streamFirstChunkTokens, 20, 'streamFirstChunkTokens forwarded to params')
})

test('Parler: GPU options forward to params (useGPU / nGpuLayers)', (t) => {
  const gpu = createMockedParlerModel({ extra: { config: { useGPU: true } } })
  t.is(gpu._buildTtsParams().useGPU, true, 'useGPU:true forwards to params')

  const layers = createMockedParlerModel({ extra: { nGpuLayers: 99 } })
  t.is(layers._buildTtsParams().nGpuLayers, 99, 'nGpuLayers forwards to params')

  // The engine-agnostic conflict guard still applies to parler.
  t.exception(
    () => createMockedParlerModel({ extra: { config: { useGPU: false }, nGpuLayers: 99 } }),
    /conflicts/,
    'useGPU:false + nGpuLayers:99 conflict rejects'
  )
})

test('Parler: parler-only options on other engines throw', (t) => {
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_SUPERTONIC,
        files: { supertonicModel: './models/supertonic.gguf' },
        emotion: 'happy'
      }),
    /parler-only/,
    'emotion on supertonic throws'
  )
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_CHATTERBOX,
        files: { t3Model: './models/t3.gguf', s3genModel: './models/s3gen.gguf' },
        temperature: 0.8
      }),
    /parler-only/,
    'temperature on chatterbox throws'
  )
})

test('Parler: per-call description/template fields land on the jobData', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedParlerModel({ binding, extra: { voice: 'Laura' } })
  await model.load()

  const r1 = await model.run({ type: 'text', input: 'Merged emotion.', emotion: 'sad' })
  await r1.await()
  t.is(binding.jobs.length, 1, 'one job ran')
  t.is(binding.jobs[0].emotion, 'sad', 'per-call emotion rides on jobData')
  t.absent(binding.jobs[0].voice, 'ctor-level voice is NOT re-sent per call (merged natively)')

  const r2 = await model.run({
    type: 'text',
    input: 'Full description.',
    description: 'A deep male voice.'
  })
  await r2.await()
  t.is(binding.jobs[1].description, 'A deep male voice.', 'per-call description on jobData')

  const r3 = await model.run({ type: 'text', input: 'Plain run.' })
  await r3.await()
  t.absent(binding.jobs[2].emotion, 'no leftover fields on a plain run')
  t.absent(binding.jobs[2].description, 'no leftover description on a plain run')

  await model.unload()
})

test('Parler: per-call conflicts reject before any job is queued', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedParlerModel({ binding })
  await model.load()

  await t.exception(
    model.run({ type: 'text', input: 'x', description: 'A voice.', emotion: 'sad' }),
    /mutually exclusive/,
    'same-level per-call conflict rejects'
  )
  t.is(binding.jobs.length, 0, 'no job queued on conflict')
  await model.unload()
})

test('Parler: per-call template + constructor description rejects', async (t) => {
  const model = createMockedParlerModel({ extra: { description: 'A calm voice.' } })
  await model.load()
  await t.exception(
    model.run({ type: 'text', input: 'x', emotion: 'sad' }),
    /constructor-level description/,
    'cross-level conflict rejects'
  )
  await model.unload()
})

test('Parler: per-call fields on other engines throw', async (t) => {
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
    model.run({ type: 'text', input: 'x', emotion: 'happy' }),
    /parler-only/,
    'per-call emotion on supertonic rejects'
  )
  await model.unload()
})

test('Parler: runStream pins the per-call fields on every chunk jobData', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedParlerModel({ binding })
  await model.load()

  const text = 'First chunk sentence. Second chunk sentence.'
  const r = await model.runStream(text, { maxChunkScalars: 20, voice: 'Rohit', emotion: 'news' })
  const updates = []
  await r.onUpdate((d) => updates.push(d)).await()

  t.ok(binding.jobs.length >= 2, `stream ran multiple jobs (got ${binding.jobs.length})`)
  for (const job of binding.jobs) {
    t.is(job.voice, 'Rohit', 'every chunk jobData carries the pinned voice')
    t.is(job.emotion, 'news', 'every chunk jobData carries the pinned emotion')
  }
  await model.unload()
})

test('Parler: runStreaming forwards fields from options to each yielded job', async (t) => {
  const binding = new RecordingBinding()
  const model = createMockedParlerModel({ binding })
  await model.load()

  async function* lines() {
    yield 'First yielded sentence.'
    yield 'Second yielded sentence.'
  }
  const r = await model.runStreaming(lines(), { emotion: 'happy' })
  await r.onUpdate(() => {}).await()

  t.is(binding.jobs.length, 2, 'one job per yielded sentence')
  t.ok(
    binding.jobs.every((j) => j.emotion === 'happy'),
    'every yielded job carries the pinned emotion'
  )
  await model.unload()
})

test('Parler: reload merges description/template + sampling knobs', async (t) => {
  const model = createMockedParlerModel({
    extra: { voice: 'Laura', emotion: 'happy', temperature: 1.0 }
  })
  await model.load()

  await model.reload({ emotion: 'sad', temperature: 0.8, voice: 'Rohit' })
  const params = model._buildTtsParams()
  t.is(params.emotion, 'sad', 'reload updates emotion')
  t.is(params.voice, 'Rohit', 'reload updates voice')
  t.is(params.temperature, 0.8, 'reload updates temperature')

  // reload can switch GPU intent (parler is no longer CPU-only).
  await model.reload({ useGPU: true })
  t.is(model._buildTtsParams().useGPU, true, 'reload({useGPU:true}) forwards useGPU')
  await model.unload()
})
