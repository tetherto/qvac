'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

function createMockedSupertonicModel ({
  onOutput = () => {},
  binding,
  files,
  voice = 'F1',
  steps = 5,
  speed = 1,
  language = 'en',
  exclusiveRun = false,
  extra = {}
} = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: files || { supertonicModel: './models/supertonic.gguf' },
    voice,
    steps,
    speed,
    config: { language, useGPU: false },
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

test('Supertonic: explicit engine option routes to supertonic', (t) => {
  const model = createMockedSupertonicModel()
  t.is(model.getEngineType(), TTSGgml.ENGINE_SUPERTONIC, 'engine: supertonic detected')
  t.is(model._supertonicModelPath, './models/supertonic.gguf')
  t.absent(model._t3ModelPath, 'no t3 path on supertonic')
  t.absent(model._s3genModelPath, 'no s3gen path on supertonic')
})

test('Supertonic: supertonicModel file path alone routes to supertonic engine', (t) => {
  const model = new TTSGgml({
    files: { supertonicModel: './models/super.gguf' },
    config: { language: 'en' }
  })
  t.is(model.getEngineType(), TTSGgml.ENGINE_SUPERTONIC, 'supertonicModel file detected')
})

test('Supertonic: ttsParams shape passes voice/steps/speed/seed/threads/useGPU', (t) => {
  const model = createMockedSupertonicModel({
    voice: 'M2',
    steps: 8,
    speed: 1.25,
    extra: { seed: 7, threads: 2, nGpuLayers: 0 }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_SUPERTONIC)
  t.is(params.supertonicModelPath, './models/supertonic.gguf')
  t.is(params.voice, 'M2')
  t.is(params.steps, 8)
  t.is(params.speed, 1.25)
  t.is(params.seed, 7)
  t.is(params.threads, 2)
  t.is(params.nGpuLayers, 0, 'nGpuLayers passes through to params (0 here)')
  t.is(params.useGPU, false, 'useGPU follows config.useGPU')
  t.absent(params.t3ModelPath, 'no t3 path leaked into supertonic params')
  t.absent(params.s3genModelPath, 'no s3gen path leaked into supertonic params')
})

test('Supertonic: voice option also accepts voiceName for ONNX-tts cross-compat', (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: './models/supertonic.gguf' },
    voiceName: 'F1',
    numInferenceSteps: 3,
    config: { language: 'en' }
  })
  const params = model._buildTtsParams()
  t.is(params.voice, 'F1', 'voiceName aliases to voice')
  t.is(params.steps, 3, 'numInferenceSteps aliases to steps')
})

test('Supertonic: synthesis returns audio output and stats', async (t) => {
  const events = []
  const model = createMockedSupertonicModel({
    onOutput: (addon, event, data, error) => events.push({ event, data, error })
  })
  await model.load()

  const response = await model.run({ type: 'text', input: 'Hello supertonic.' })
  const outputs = []
  await response.onUpdate(d => outputs.push(d)).await()

  t.ok(outputs.length > 0, 'supertonic emits at least one update')
  t.ok(outputs.some(d => d.outputArray), 'supertonic output has outputArray')
  t.ok(response.stats.totalSamples > 0, 'supertonic stats include totalSamples')
  t.ok(events.length > 0, 'raw addon callback fired for supertonic run')
  await model.unload()
})

test('Supertonic: cancel propagates as job failure', async (t) => {
  const model = createMockedSupertonicModel()
  await model.load()

  const response = await model.run({ type: 'text', input: 'Cancel this' })
  await response.cancel()

  let failed = false
  try {
    await response.await()
  } catch (error) {
    failed = true
    t.ok(String(error.message).includes('cancel'), 'cancelled supertonic response rejects')
  }
  t.ok(failed, 'cancelled supertonic response should fail')
  await model.unload()
})

test('Supertonic: invalid engine option rejects at constructor time', (t) => {
  let threw = false
  try {
    /* eslint no-new: 0 */
    new TTSGgml({
      engine: 'parakeet',
      files: { supertonicModel: './models/supertonic.gguf' }
    })
  } catch (e) {
    threw = true
    t.ok(String(e.message).includes('chatterbox'), 'error message lists valid engines')
  }
  t.ok(threw, 'invalid engine should throw')
})

test('Supertonic: streamChunkTokens / streamFirstChunkTokens rejected at constructor', (t) => {
  for (const knob of ['streamChunkTokens', 'streamFirstChunkTokens']) {
    let threw = false
    try {
      /* eslint no-new: 0 */
      new TTSGgml({
        engine: TTSGgml.ENGINE_SUPERTONIC,
        files: { supertonicModel: './models/supertonic.gguf' },
        [knob]: 25
      })
    } catch (e) {
      threw = true
      t.ok(
        /Chatterbox-only/.test(e.message),
        `${knob} error mentions Chatterbox-only`
      )
      t.ok(
        /runStream\(\) \/ runStreaming\(\)/.test(e.message),
        `${knob} error points at sentence-level streaming alternative`
      )
    }
    t.ok(threw, `passing ${knob} on supertonic should throw`)
  }
})

test('Supertonic: runStream emits per-sentence chunks with chunkIndex + isLast (mocked)', async (t) => {
  const model = createMockedSupertonicModel()
  await model.load()
  const text = 'First chunk one. Second chunk two. Third chunk three.'
  const r = await model.runStream(text, { maxChunkScalars: 18 })
  const updates = []
  await r.onUpdate(d => updates.push(d)).await()

  const withChunk = updates.filter(u => u.chunkIndex !== undefined)
  t.ok(withChunk.length >= 2, 'supertonic runStream emits multiple chunks')
  t.is(withChunk[0].chunkIndex, 0, 'first chunkIndex is 0')
  t.ok(typeof withChunk[0].sentenceChunk === 'string', 'sentenceChunk is a string')
  const isLastFlags = withChunk.map(u => !!u.isLast)
  t.is(isLastFlags.filter(Boolean).length, 1, 'exactly one isLast=true on the final chunk')
  t.is(isLastFlags[isLastFlags.length - 1], true, 'final chunk carries isLast=true')
  t.is(isLastFlags[0], false, 'first chunk is not isLast (if multiple chunks)')
  await model.unload()
})

test('Supertonic: runStreaming with async iterator drives one job per sentence (mocked)', async (t) => {
  const model = createMockedSupertonicModel()
  await model.load()
  async function * lines () {
    yield 'First yielded sentence.'
    yield 'Second yielded sentence.'
    yield 'Third yielded sentence.'
  }
  const r = await model.runStreaming(lines())
  const updates = []
  await r.onUpdate(d => updates.push(d)).await()

  const withChunk = updates.filter(u => u.chunkIndex !== undefined)
  t.is(withChunk.length, 3, 'supertonic runStreaming emits 3 chunks')
  t.is(withChunk[0].chunkIndex, 0)
  t.is(withChunk[2].chunkIndex, 2)
  t.ok(withChunk.every(u => u.isLast === undefined), 'isLast is undefined for async-iter mode (count not known up-front)')
  await model.unload()
})

test('Supertonic: modelDir auto-detects supertonic.gguf', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const tmpRoot = path.join(os.tmpdir(), 'tts-ggml-supertonic-detect-' + Date.now())
  try {
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'supertonic.gguf'), 'super-marker')

    const model = new TTSGgml({
      files: { modelDir: tmpRoot },
      voice: 'F1',
      config: { language: 'en', useGPU: false }
    })
    t.is(model.getEngineType(), TTSGgml.ENGINE_SUPERTONIC, 'modelDir with supertonic.gguf detected')
    t.is(
      model._supertonicModelPath,
      path.join(tmpRoot, 'supertonic.gguf'),
      'supertonic path resolved from modelDir'
    )
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_e) {}
  }
})

// === LavaSR enhancer param forwarding ===
// Enhancement is enabled purely by the presence of a GGUF path; there is no
// `enhance` flag for this layer to forward or keep in sync.

test('Supertonic: files.lavasrEnhancer forwards lavasrEnhancerPath (no enhance flag)', (t) => {
  const model = createMockedSupertonicModel({
    files: {
      supertonicModel: './models/supertonic.gguf',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, './models/lavasr/lavasr-enhancer.gguf')
  t.absent(params.enhance, 'no separate enhance flag is forwarded')
})

test('Supertonic: enhancerPath via enhancer block (no files) forwards the path', (t) => {
  const model = createMockedSupertonicModel({
    extra: { enhancer: { type: 'lavasr', enhancerPath: '/abs/enh.gguf' } }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf')
  t.absent(params.enhance, 'presence of the path is what enables enhancement')
})

test('Supertonic: unknown enhancer.type is rejected at construction', (t) => {
  t.exception(
    () => createMockedSupertonicModel({
      files: {
        supertonicModel: './models/supertonic.gguf',
        lavasrEnhancer: '/abs/enh.gguf'
      },
      extra: { enhancer: { type: 'bogus' } }
    }),
    /unknown enhancer\.type/,
    'a typo in enhancer.type throws instead of silently disabling enhancement'
  )
})

test('Supertonic: enhancer block without a path is a no-op (no enhancer params)', (t) => {
  const model = createMockedSupertonicModel({
    extra: { enhancer: { type: 'lavasr' } }
  })
  const params = model._buildTtsParams()
  t.absent(params.lavasrEnhancerPath, 'no resolvable path -> enhancement stays off')
})

test('Supertonic: no enhancer -> no enhancer params (backward compat)', (t) => {
  const model = createMockedSupertonicModel()
  const params = model._buildTtsParams()
  t.absent(params.lavasrEnhancerPath, 'no lavasrEnhancerPath when enhancer absent')
  t.absent(params.enhance, 'no enhance flag when enhancer absent')
})

// === LavaSR denoiser param forwarding ===
// Mirrors the enhancer: enabled purely by a GGUF path, runs before the
// enhancer, rate-preserving. The tts-cpp UL-UNAS forward is implemented in
// qvac-ext-lib-whisper.cpp PR #78; these tests exercise the JS wiring
// (path forwarding + validation) without loading a model.

test('Supertonic: files.lavasrDenoiser forwards lavasrDenoiserPath', (t) => {
  const model = createMockedSupertonicModel({
    files: {
      supertonicModel: './models/supertonic.gguf',
      lavasrDenoiser: './models/lavasr/lavasr-denoiser.gguf'
    }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrDenoiserPath, './models/lavasr/lavasr-denoiser.gguf')
})

test('Supertonic: denoiserPath via denoiser block (no files) forwards the path', (t) => {
  const model = createMockedSupertonicModel({
    extra: { denoiser: { type: 'lavasr', denoiserPath: '/abs/den.gguf' } }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrDenoiserPath, '/abs/den.gguf')
})

test('Supertonic: unknown denoiser.type is rejected at construction', (t) => {
  t.exception(
    () => createMockedSupertonicModel({
      files: {
        supertonicModel: './models/supertonic.gguf',
        lavasrDenoiser: '/abs/den.gguf'
      },
      extra: { denoiser: { type: 'bogus' } }
    }),
    /unknown denoiser\.type/,
    'a typo in denoiser.type throws instead of silently disabling denoising'
  )
})

test('Supertonic: denoiser and enhancer forward both paths (denoise before enhance)', (t) => {
  const model = createMockedSupertonicModel({
    files: {
      supertonicModel: './models/supertonic.gguf',
      lavasrEnhancer: '/abs/enh.gguf',
      lavasrDenoiser: '/abs/den.gguf'
    }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf', 'enhancer path forwarded')
  t.is(params.lavasrDenoiserPath, '/abs/den.gguf', 'denoiser path forwarded alongside enhancer')
})

test('Supertonic: no denoiser -> no denoiser params (backward compat)', (t) => {
  const model = createMockedSupertonicModel()
  t.absent(model._buildTtsParams().lavasrDenoiserPath, 'no lavasrDenoiserPath when denoiser absent')
})

// === Output sample rate ===

test('Supertonic: outputSampleRate forwards to ttsParams; omitted when unset', (t) => {
  const withRate = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: './models/supertonic.gguf' },
    config: { language: 'en', outputSampleRate: 16000 }
  })
  t.is(withRate._buildTtsParams().outputSampleRate, 16000, 'outputSampleRate forwarded to native params')

  const noRate = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: './models/supertonic.gguf' },
    config: { language: 'en' }
  })
  t.absent(noRate._buildTtsParams().outputSampleRate, 'no outputSampleRate when unset (engine keeps native)')
})

test('Supertonic: out-of-range outputSampleRate rejected at construction', (t) => {
  for (const bad of [999, 200000]) {
    t.exception(() => new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: { supertonicModel: './models/supertonic.gguf' },
      config: { language: 'en', outputSampleRate: bad }
    }), /between 8000 and 192000/, `outputSampleRate=${bad} rejected`)
  }
})

test('Supertonic: outputSampleRate coexists with the enhancer (no longer ignored)', (t) => {
  // Both set is now valid (enhancer -> 48 kHz -> resample to outputSampleRate);
  // it must NOT throw at construction.
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: './models/supertonic.gguf', lavasrEnhancer: '/abs/enh.gguf' },
    enhancer: { type: 'lavasr' },
    config: { language: 'en', outputSampleRate: 22050 }
  })
  const params = model._buildTtsParams()
  t.is(params.outputSampleRate, 22050, 'outputSampleRate forwarded alongside the enhancer')
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf', 'enhancer still forwarded')
})
