'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

// CosyVoice3 (Fun-CosyVoice3-0.5B / 1.5B). These unit tests exercise the JS
// wiring (engine detection, param building, mocked synthesis) without the
// native addon; the C++ config validation + real inference round-trips are
// covered by addon/tests/test_cosyvoice_config.cpp.

function createMockedCosyvoiceModel({
  onOutput = () => {},
  binding,
  files,
  language = 'en',
  exclusiveRun = false,
  extra = {}
} = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: files || { cosyvoiceModelDir: './models/cosyvoice3' },
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

test('CosyVoice3: explicit engine option routes to cosyvoice3', (t) => {
  const model = createMockedCosyvoiceModel()
  t.is(model.getEngineType(), TTSGgml.ENGINE_COSYVOICE3, 'engine: cosyvoice3 detected')
  t.is(model._cosyvoiceModelDir, './models/cosyvoice3')
  t.absent(model._t3ModelPath, 'no chatterbox t3 path on cosyvoice3')
  t.absent(model._supertonicModelPath, 'no supertonic path on cosyvoice3')
})

test('CosyVoice3: cosyvoiceModelDir file input alone routes to cosyvoice3', (t) => {
  const model = new TTSGgml({
    files: { cosyvoiceModelDir: './models/cv3' },
    config: { language: 'en' }
  })
  t.is(model.getEngineType(), TTSGgml.ENGINE_COSYVOICE3, 'cosyvoiceModelDir detected')
})

test('CosyVoice3: cosyvoiceLlmModel path alone routes to cosyvoice3', (t) => {
  const model = new TTSGgml({
    files: { cosyvoiceLlmModel: './models/cv3/cosyvoice3-llm-f16.gguf' },
    config: { language: 'en' }
  })
  t.is(model.getEngineType(), TTSGgml.ENGINE_COSYVOICE3, 'cosyvoiceLlmModel detected')
})

test('CosyVoice3: modelDir auto-detects cosyvoice3-llm gguf', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const tmpRoot = path.join(os.tmpdir(), 'tts-ggml-cosyvoice-detect-' + Date.now())
  try {
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'cosyvoice3-llm-f16.gguf'), 'cv3-marker')

    const model = new TTSGgml({
      files: { modelDir: tmpRoot },
      config: { language: 'en', useGPU: false }
    })
    t.is(
      model.getEngineType(),
      TTSGgml.ENGINE_COSYVOICE3,
      'modelDir with cosyvoice3-llm*.gguf detected'
    )
    t.is(model._cosyvoiceModelDir, tmpRoot, 'cosyvoiceModelDir resolved from modelDir')
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch (_e) {}
  }
})

test('CosyVoice3: ttsParams shape forwards dir/language/streaming/cfm/promptText', (t) => {
  const model = createMockedCosyvoiceModel({
    extra: {
      streamChunkTokens: 25,
      streamFirstChunkTokens: 10,
      streamLeftContextTokens: 50,
      cfmSteps: 10,
      promptText: 'reference transcript',
      seed: 7,
      threads: 2,
      nGpuLayers: 0
    }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_COSYVOICE3)
  t.is(params.cosyvoiceModelDir, './models/cosyvoice3')
  t.is(params.language, 'en')
  t.is(params.streamChunkTokens, 25)
  t.is(params.streamFirstChunkTokens, 10)
  t.is(params.streamLeftContextTokens, 50)
  t.is(params.cfmSteps, 10)
  t.is(params.promptText, 'reference transcript')
  t.is(params.seed, 7)
  t.is(params.threads, 2)
  t.is(params.nGpuLayers, 0)
  t.is(params.useGPU, false, 'useGPU follows config.useGPU')
  t.absent(params.t3ModelPath, 'no chatterbox fields leaked')
  t.absent(params.supertonicModelPath, 'no supertonic fields leaked')
})

test('CosyVoice3: runCosyvoiceTTS helper forwards GPU options into TTSGgml options', (t) => {
  const { buildCosyvoiceLoadOptions } = require('../utils/runCosyvoiceTTS')

  const layers = buildCosyvoiceLoadOptions({ nGpuLayers: 99 })
  t.is(layers.nGpuLayers, 99, 'helper forwards nGpuLayers as a top-level option')

  const gpu = buildCosyvoiceLoadOptions({ useGPU: true })
  t.is(gpu.config.useGPU, true, 'helper forwards useGPU into config (explicit wins over NO_GPU)')
  t.absent(gpu.nGpuLayers, 'no nGpuLayers unless requested')

  const none = buildCosyvoiceLoadOptions({})
  t.absent(none.nGpuLayers, 'omitted nGpuLayers stays omitted')
})

test('CosyVoice3: GPU options forward to params (useGPU / nGpuLayers)', (t) => {
  const gpu = createMockedCosyvoiceModel({ extra: { config: { language: 'en', useGPU: true } } })
  t.is(gpu._buildTtsParams().useGPU, true, 'useGPU:true forwards to params')

  const layers = createMockedCosyvoiceModel({
    extra: { config: { language: 'en' }, nGpuLayers: 99 }
  })
  t.is(layers._buildTtsParams().nGpuLayers, 99, 'nGpuLayers forwards to params')

  t.exception(
    () =>
      createMockedCosyvoiceModel({
        extra: { config: { language: 'en', useGPU: false }, nGpuLayers: 99 }
      }),
    /conflicts/,
    'useGPU:false + nGpuLayers:99 conflict rejects'
  )
})

test('CosyVoice3: per-component model paths forward to params', (t) => {
  const model = createMockedCosyvoiceModel({
    files: {
      cosyvoiceModelDir: './models/cv3',
      cosyvoiceLlmModel: './models/cv3/llm.gguf',
      cosyvoiceFlowModel: './models/cv3/flow.gguf',
      cosyvoiceHiftModel: './models/cv3/hift.gguf'
    }
  })
  const params = model._buildTtsParams()
  t.is(params.cosyvoiceLlmModelPath, './models/cv3/llm.gguf')
  t.is(params.cosyvoiceFlowModelPath, './models/cv3/flow.gguf')
  t.is(params.cosyvoiceHiftModelPath, './models/cv3/hift.gguf')
})

// Guards the JS half of the openclCacheDir boundary: the native
// buildCosyvoiceConfig reads the "openclCacheDir" key by name and forwards it to
// EngineOptions::opencl_cache_dir (covered on the C++ side by
// test_cosyvoice_config.cpp CosyvoiceEngineOptions.ForwardsOpenclCacheDir). The
// original regression was the addon dropping this key, so pin that the JS layer
// emits it under the exact name from both the top-level option and config.
test('CosyVoice3: openclCacheDir forwards into the native configuration params', (t) => {
  const fromOption = createMockedCosyvoiceModel({
    extra: { openclCacheDir: '/var/cache/qvac/opencl' }
  })
  t.is(
    fromOption._buildTtsParams().openclCacheDir,
    '/var/cache/qvac/opencl',
    'openclCacheDir option reaches the native configurationParams'
  )

  const fromConfig = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: { cosyvoiceModelDir: './models/cosyvoice3' },
    config: { language: 'en', useGPU: false, openclCacheDir: '/data/opencl' }
  })
  t.is(
    fromConfig._buildTtsParams().openclCacheDir,
    '/data/opencl',
    'config.openclCacheDir reaches the native configurationParams'
  )
})

test('CosyVoice3: instruct renders the controls with no canonical vocabulary', (t) => {
  const dialect = createMockedCosyvoiceModel({ extra: { instruct: { dialect: 'cantonese' } } })
  t.is(dialect._buildTtsParams().instruct, '请用广东话表达。', 'dialect renders')

  const volume = createMockedCosyvoiceModel({ extra: { instruct: { volume: 'loud' } } })
  t.ok(volume._buildTtsParams().instruct.includes('loudly'), 'volume renders')

  const raw = createMockedCosyvoiceModel({ extra: { instruct: '请用四川话表达。' } })
  t.is(raw._buildTtsParams().instruct, '请用四川话表达。', 'raw string passes through')

  const precedence = createMockedCosyvoiceModel({
    extra: { instruct: { dialect: 'sichuan', volume: 'soft' } }
  })
  t.is(precedence._buildTtsParams().instruct, '请用四川话表达。', 'dialect wins over volume')

  const none = createMockedCosyvoiceModel({})
  t.absent(none._buildTtsParams().instruct, 'no instruct -> field absent')
})

test('CosyVoice3: emotion and pace are forwarded canonically, not pre-rendered', (t) => {
  // The trained Chinese instructions live in tts-cpp now, so the addon must
  // pass the canonical value through rather than render it here.
  const happy = createMockedCosyvoiceModel({ extra: { emotion: 'happy' } })
  t.is(happy._buildTtsParams().emotion, 'happy', 'emotion forwarded verbatim')
  t.absent(happy._buildTtsParams().instruct, 'emotion does not populate instruct')

  const slow = createMockedCosyvoiceModel({ extra: { pace: 'slow' } })
  t.is(slow._buildTtsParams().pace, 'slow', 'pace forwarded verbatim')

  const neutral = createMockedCosyvoiceModel({ extra: { emotion: 'neutral' } })
  t.is(neutral._buildTtsParams().emotion, 'neutral', 'neutral is accepted')
})

// The determinism knobs the cosyvoice integration helper sets, pinned here
// because the integration lane is the only other place that constructs with
// them and it takes hours to tell you.
test('CosyVoice3: seed is the determinism knob; greedy belongs to audio8', (t) => {
  const seeded = createMockedCosyvoiceModel({ extra: { seed: 42 } })
  t.is(seeded._buildTtsParams().seed, 42, 'seed reaches the native configurationParams')

  t.exception(
    () => createMockedCosyvoiceModel({ extra: { greedy: true } }),
    /audio8-only/,
    'greedy is not a cosyvoice3 option'
  )
})

test('CosyVoice3: unsupported emotions and instruct keys are rejected', (t) => {
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: { dialect: 'nope' } } }),
    /Valid dialects|Invalid CosyVoice instruct/,
    'invalid dialect value throws'
  )
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: { dialekt: 'cantonese' } } }),
    /Invalid CosyVoice instruct key/,
    'unknown structured key throws instead of silently zero-shot'
  )
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: { emotion: 'happy' } } }),
    /Valid keys: dialect, volume, style/,
    'emotion under instruct is rejected and points at the top-level option'
  )
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { emotion: 'angry' } }),
    /invalid emotion/,
    'the upstream spelling angry is not canonical'
  )
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { emotion: 'fear' } }),
    /not supported by the cosyvoice3 engine/,
    'an untrained emotion names the engine set'
  )
})

test('CosyVoice3: one instruction per synthesis', (t) => {
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { emotion: 'happy', pace: 'fast' } }),
    /one instruction per synthesis/,
    'emotion + pace conflicts'
  )
  t.exception(
    () =>
      createMockedCosyvoiceModel({
        extra: { emotion: 'happy', instruct: { dialect: 'cantonese' } }
      }),
    /one instruction per synthesis/,
    'emotion + instruct conflicts'
  )
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { emotion: 'neutral', pace: 'fast' } }),
    /one instruction per synthesis/,
    'neutral carries its own instruction, so it conflicts with a pace step too'
  )
  t.execution(
    () => createMockedCosyvoiceModel({ extra: { emotion: 'happy', pace: 'moderate' } }),
    'moderate disengages its channel so it does not conflict'
  )
  t.execution(
    () => createMockedCosyvoiceModel({ extra: { emotion: 'neutral', pace: 'moderate' } }),
    'neutral plus the disengaged pace is still one instruction'
  )
})

test('CosyVoice3: malformed instruct values rejected instead of silent zero-shot', (t) => {
  // Presence, not truthiness: a set-but-empty or null control is malformed and
  // must throw rather than degrade to zero-shot synthesis.
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: { dialect: '' } } }),
    /Invalid CosyVoice instruct/,
    'empty dialect string throws'
  )
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: { dialect: null } } }),
    /Invalid CosyVoice instruct/,
    'null dialect throws'
  )
  // Non-object structured values would slip past the presence checks.
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: ['cantonese'] } }),
    /control object/,
    'array instruct throws'
  )
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: 42 } }),
    /control object/,
    'numeric instruct throws'
  )
})

test('CosyVoice3: explicit null instruct is rejected, not treated as omitted', (t) => {
  // Only `undefined` means omitted (zero-shot); an explicit null is malformed.
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: null } }),
    /control object/,
    'null instruct throws instead of silently selecting zero-shot'
  )
})

test('CosyVoice3: non-plain instruct objects are rejected', (t) => {
  // A Date is an object but not a control map; without a plain-object check it
  // would carry no control fields and degrade to silent zero-shot.
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: new Date() } }),
    /control object/,
    'Date instruct throws'
  )
  // Controls inherited from a prototype must not be honored: only own
  // properties of a plain object count.
  const inherited = Object.create({ dialect: 'cantonese' })
  t.exception(
    () => createMockedCosyvoiceModel({ extra: { instruct: inherited } }),
    /control object/,
    'prototype-inherited control throws instead of being accepted'
  )
})

test('CosyVoice3: undefined control fields are skipped, not malformed', (t) => {
  // A field explicitly set to undefined means "not selected", so it is skipped
  // and the next control by precedence takes effect (zero-shot when none do).
  const skipped = createMockedCosyvoiceModel({
    extra: { instruct: { dialect: undefined, volume: 'loud' } }
  })
  t.is(
    skipped._buildTtsParams().instruct,
    'Please say a sentence as loudly as possible.',
    'undefined dialect falls through to volume'
  )

  const empty = createMockedCosyvoiceModel({ extra: { instruct: { dialect: undefined } } })
  t.absent(empty._buildTtsParams().instruct, 'all-undefined instruct -> zero-shot, field absent')
})

test('CosyVoice3: LavaSR enhancer/denoiser accepted and forwarded to the addon', (t) => {
  const model = createMockedCosyvoiceModel({
    files: {
      cosyvoiceModelDir: './models/cv3',
      lavasrEnhancer: './e.gguf',
      lavasrDenoiser: './d.gguf'
    }
  })
  const parameters = model._buildTtsParams()
  t.is(parameters.lavasrEnhancerPath, './e.gguf', 'enhancer path forwarded')
  t.is(parameters.lavasrDenoiserPath, './d.gguf', 'denoiser path forwarded')
})

test('CosyVoice3: LavaSR enhancer works with native chunk streaming', (t) => {
  const model = createMockedCosyvoiceModel({
    files: { cosyvoiceModelDir: './models/cv3', lavasrEnhancer: './e.gguf' },
    extra: { streamChunkTokens: 25 }
  })
  const parameters = model._buildTtsParams()
  t.is(parameters.lavasrEnhancerPath, './e.gguf', 'enhancer survives streaming')
  t.is(parameters.streamChunkTokens, 25, 'streaming still requested')
})

test('CosyVoice3: LavaSR denoiser rejected with native chunk streaming', (t) => {
  t.exception(
    () =>
      createMockedCosyvoiceModel({
        files: { cosyvoiceModelDir: './models/cv3', lavasrDenoiser: './d.gguf' },
        extra: { streamChunkTokens: 25 }
      }),
    /denoiser is not yet supported with native chunk streaming/,
    'denoiser + streaming rejected at construction'
  )
})

test('CosyVoice3: LavaSR denoiser accepted with streamFirstChunkTokens alone', (t) => {
  // CosyvoiceModel::validateConfig starts streaming on streamChunkTokens > 0
  // alone, so a first-chunk size without it is batch and keeps the denoiser.
  const model = createMockedCosyvoiceModel({
    files: { cosyvoiceModelDir: './models/cv3', lavasrDenoiser: './d.gguf' },
    extra: { streamFirstChunkTokens: 20 }
  })
  const parameters = model._buildTtsParams()
  t.is(parameters.lavasrDenoiserPath, './d.gguf', 'denoiser survives a batch config')
  t.is(parameters.streamChunkTokens, undefined, 'no chunk streaming requested')
})

test('CosyVoice3: cosyvoice3-only options on other engines throw', (t) => {
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_CHATTERBOX,
        files: { t3Model: './models/t3.gguf', s3genModel: './models/s3gen.gguf' },
        instruct: { dialect: 'cantonese' }
      }),
    /cosyvoice3-only/,
    'instruct on chatterbox throws'
  )
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_CHATTERBOX,
        files: { t3Model: './models/t3.gguf', s3genModel: './models/s3gen.gguf' },
        promptText: 'hello'
      }),
    /cosyvoice3-only/,
    'promptText on chatterbox throws'
  )
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_CHATTERBOX,
        files: { t3Model: './models/t3.gguf', s3genModel: './models/s3gen.gguf' },
        streamLeftContextTokens: 8
      }),
    /cosyvoice3-only/,
    'streamLeftContextTokens on chatterbox throws'
  )
})

test('CosyVoice3: LavaSR denoiser + streamChunkTokens 0 is accepted', (t) => {
  const model = createMockedCosyvoiceModel({
    files: { cosyvoiceModelDir: './models/cv3', lavasrDenoiser: './d.gguf' },
    extra: { streamChunkTokens: 0 }
  })
  const parameters = model._buildTtsParams()
  t.is(parameters.lavasrDenoiserPath, './d.gguf', '0 tokens means batch, so the denoiser survives')
})

test('CosyVoice3: streamChunkTokens is NOT rejected (native streaming model)', (t) => {
  // Unlike Supertonic, CosyVoice3 supports native sub-utterance chunk streaming.
  t.execution(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_COSYVOICE3,
        files: { cosyvoiceModelDir: './models/cv3' },
        streamChunkTokens: 25,
        config: { language: 'en' }
      }),
    'streamChunkTokens accepted on cosyvoice3'
  )
})

test('CosyVoice3: referenceAudio forwards for zero-shot cloning', (t) => {
  const model = createMockedCosyvoiceModel({
    extra: { referenceAudio: '/abs/ref.wav', promptText: 'hi there' }
  })
  const params = model._buildTtsParams()
  t.is(params.referenceAudio, '/abs/ref.wav')
  t.is(params.promptText, 'hi there')
})

test('CosyVoice3: referenceAudio without cloning models or a model dir throws', (t) => {
  // The clone consistency assert must fail closed at construction: with no
  // model dir to discover the s3tok/campplus GGUFs under and no explicit
  // paths, the native bake could never succeed.
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_COSYVOICE3,
        referenceAudio: '/abs/ref.wav',
        files: {
          cosyvoiceLlmModel: './llm.gguf',
          cosyvoiceFlowModel: './flow.gguf',
          cosyvoiceHiftModel: './hift.gguf'
        }
      }),
    /cosyvoiceS3tokModel/,
    'clone request with unresolvable cloning models is rejected'
  )
})

test('CosyVoice3: referenceAudio with explicit s3tok + campplus paths is accepted', (t) => {
  // The other side of the clone assert: explicit cloning-model paths satisfy
  // it without a model dir, and both forward to the addon.
  let model
  t.execution(() => {
    model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      referenceAudio: '/abs/ref.wav',
      files: {
        cosyvoiceLlmModel: './llm.gguf',
        cosyvoiceFlowModel: './flow.gguf',
        cosyvoiceHiftModel: './hift.gguf',
        cosyvoiceS3tokModel: './cosyvoice3-s3tok-q8_0.gguf',
        cosyvoiceCampplusModel: './cosyvoice3-campplus-f32.gguf'
      }
    })
  }, 'explicit cloning-model paths satisfy the clone assert')
  const params = model._buildTtsParams()
  t.is(params.cosyvoiceS3tokModelPath, './cosyvoice3-s3tok-q8_0.gguf')
  t.is(params.cosyvoiceCampplusModelPath, './cosyvoice3-campplus-f32.gguf')
})

test('CosyVoice3: promptText alone (no referenceAudio) stays legal', (t) => {
  // Without a reference it is the baked-voice transcript override, not a
  // clone request, so the cloning models are not required.
  t.execution(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_COSYVOICE3,
        promptText: 'transcript override for the baked voice',
        files: { cosyvoiceModelDir: './models/cv3' }
      }),
    'promptText without referenceAudio needs no cloning models'
  )
})

test('CosyVoice3: synthesis returns audio output and stats (mocked)', async (t) => {
  const events = []
  const model = createMockedCosyvoiceModel({
    onOutput: (addon, event, data, error) => events.push({ event, data, error })
  })
  await model.load()

  const response = await model.run({ type: 'text', input: 'Hello cosyvoice.' })
  const outputs = []
  await response.onUpdate((d) => outputs.push(d)).await()

  t.ok(outputs.length > 0, 'cosyvoice emits at least one update')
  t.ok(
    outputs.some((d) => d.outputArray),
    'cosyvoice output has outputArray'
  )
  t.ok(response.stats.totalSamples > 0, 'cosyvoice stats include totalSamples')
  await model.unload()
})

test('CosyVoice3: cancel propagates as job failure (mocked)', async (t) => {
  const model = createMockedCosyvoiceModel()
  await model.load()

  const response = await model.run({ type: 'text', input: 'Cancel this' })
  await response.cancel()

  let failed = false
  try {
    await response.await()
  } catch (error) {
    failed = true
    t.ok(String(error.message).includes('cancel'), 'cancelled cosyvoice response rejects')
  }
  t.ok(failed, 'cancelled cosyvoice response should fail')
  await model.unload()
})
