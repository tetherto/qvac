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

test('CosyVoice3: instruct renders structured control to the trained instruction', (t) => {
  const dialect = createMockedCosyvoiceModel({ extra: { instruct: { dialect: 'cantonese' } } })
  t.is(dialect._buildTtsParams().instruct, '请用广东话表达。', 'dialect renders')

  const emotion = createMockedCosyvoiceModel({ extra: { instruct: { emotion: 'happy' } } })
  t.is(emotion._buildTtsParams().instruct, '请非常开心地说一句话。', 'emotion renders')

  const speed = createMockedCosyvoiceModel({ extra: { instruct: { speed: 'slow' } } })
  t.is(speed._buildTtsParams().instruct, '请用尽可能慢地语速说一句话。', 'speed renders')

  const raw = createMockedCosyvoiceModel({ extra: { instruct: '请用四川话表达。' } })
  t.is(raw._buildTtsParams().instruct, '请用四川话表达。', 'raw string passes through')

  const precedence = createMockedCosyvoiceModel({
    extra: { instruct: { dialect: 'sichuan', emotion: 'sad' } }
  })
  t.is(precedence._buildTtsParams().instruct, '请用四川话表达。', 'dialect wins over emotion')

  const none = createMockedCosyvoiceModel({})
  t.absent(none._buildTtsParams().instruct, 'no instruct -> field absent')
})

test('CosyVoice3: invalid instruct value / unknown key rejected', (t) => {
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
