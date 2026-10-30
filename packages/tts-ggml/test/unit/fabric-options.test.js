'use strict'

const test = require('brittle')
const TTSGgml = require('../../index')
const { TTSInterface } = require('../../tts')
const MockedBinding = require('../mock/MockedBinding')
const { resolveEngineSetup } = require('../../lib/setup')
const { applyReloadableConfig } = require('../../lib/reload')

const FILES = {
  pocket: { modelDir: '/models/pocket' },
  moss: { mossBackbone: '/models/moss.gguf', mossCodecDecoder: '/models/codec.gguf' },
  supertonic: { supertonicModel: '/models/supertonic3.gguf' },
  parler: { parlerModel: '/models/parler.gguf' },
  cosyvoice3: { cosyvoiceModelDir: '/models/cosyvoice3' },
  audio8: { audio8Lm: '/models/lm.gguf', audio8CodecDecoder: '/models/codec.gguf' }
}

function model(engine, options = {}) {
  return new TTSGgml({ engine, files: FILES[engine], ...options })
}

test('Pocket accepts GPU intent and retains the CPU default', (t) => {
  t.is(model('pocket')._buildTtsParams().useGPU, false)
  t.is(model('pocket', { config: { useGPU: true } })._buildTtsParams().useGPU, true)
  const params = model('pocket', { nGpuLayers: 99 })._buildTtsParams()
  t.is(params.nGpuLayers, 99)
  t.is(params.useGPU, true)
  t.exception(() => model('pocket', { nGpuLayers: 0, config: { useGPU: true } }))
})

test('explicit backend requests survive native parameter construction', (t) => {
  for (const engine of Object.keys(FILES)) {
    const params = model(engine, {
      config: { backend: 'Vulkan0', useGPU: false }
    })._buildTtsParams()
    t.is(params.backend, 'Vulkan0', engine)
    t.is(params.useGPU, false, 'the explicit request does not rewrite legacy intent')
  }
  t.exception(() => model('moss', { config: { backend: 1 } }), /backend/)
})

test('WebGPU stays restricted to model families with established support', (t) => {
  for (const engine of ['supertonic', 'parler', 'cosyvoice3', 'audio8']) {
    t.is(model(engine, { config: { backend: 'WebGPU0' } })._buildTtsParams().backend, 'WebGPU0')
  }
  for (const engine of ['pocket', 'moss']) {
    t.exception(() => model(engine, { config: { backend: 'webgpu' } }), /established support/)
  }
})

test('MOSS keeps separate text and audio samplers and uses the configured generation budget', (t) => {
  const options = {
    nCtx: 8192,
    maxNewTokens: 4096,
    durationTokens: 3000,
    textTemperature: 0,
    textTopP: 1,
    textTopK: 0,
    audioTemperature: 1.2,
    audioTopP: 0.8,
    audioTopK: 25,
    audioRepetitionPenalty: 1.1
  }
  const params = model('moss', options)._buildTtsParams()
  for (const [key, value] of Object.entries(options)) t.is(params[key], value, key)
  t.exception(() => model('moss', { durationTokens: 3000 }), /durationTokens/)
  t.exception(() => model('moss', { maxNewTokens: 100, durationTokens: 100 }), /durationTokens/)
  t.exception(() => model('moss', { audioTopK: 1.5 }), /integer/)
  t.exception(() => model('moss', { textTemperature: Infinity }), /finite/)
  t.absent(model('moss')._buildTtsParams().maxNewTokens, 'unset keeps the native default')
})

test('Parler preserves explicit false Core ML policy values', (t) => {
  const params = model('parler', {
    coremlDecoder: false,
    coremlComputeUnits: 'cpu_and_ane',
    coremlStrict: false
  })._buildTtsParams()
  t.is(params.coremlDecoder, false)
  t.is(params.coremlStrict, false)
  t.is(params.coremlComputeUnits, 'cpu_and_ane')
  t.absent(model('parler')._buildTtsParams().coremlStrict)
  t.exception(() => model('parler', { coremlComputeUnits: 'unsupported' }), /coremlComputeUnits/)
})

test('Supertonic precision, style tensors and environment overrides are copied', (t) => {
  const ttl = new Float32Array([1, 2])
  const dp = [3, 4]
  const env = { GGML_VK_DISABLE_GRAPH: '1' }
  const instance = model('supertonic', {
    precision: 'q8_0',
    f16Attn: 0,
    f16Weights: -1,
    kvAttnType: 3,
    f16WeightsDenyList: ['decoder.weight'],
    voiceStyleTtl: ttl,
    voiceStyleDp: dp,
    vulkanEnvOverrides: env
  })
  ttl[0] = 99
  dp[0] = 99
  env.GGML_VK_DISABLE_GRAPH = '0'
  const params = instance._buildTtsParams()
  t.alike(params.voiceStyleTtl, [1, 2])
  t.alike(params.voiceStyleDp, [3, 4])
  t.alike(params.vulkanEnvOverrides, { GGML_VK_DISABLE_GRAPH: '1' })
  t.is(params.precision, 'q8_0')
  t.is(params.f16Attn, 0)
  t.is(params.f16Weights, -1)
  t.is(params.kvAttnType, 3)
  params.voiceStyleTtl[0] = 77
  t.alike(instance._buildTtsParams().voiceStyleTtl, [1, 2])
  t.exception(() => model('supertonic', { voiceStyleTtl: [1] }), /together/)
  t.exception(
    () => model('supertonic', { voiceStyleTtl: [NaN], voiceStyleDp: [1] }),
    /invalid number/
  )
  t.exception(() => model('supertonic', { vulkanEnvOverrides: { GGML_VK: true } }), /string values/)
})

test('CosyVoice keeps forced token IDs and greedy zero values', (t) => {
  const trajectory = [0, 2, 4]
  const instance = model('cosyvoice3', { greedy: false, forceSpeechTokens: trajectory })
  trajectory[0] = 99
  const params = instance._buildTtsParams()
  t.alike(params.forceSpeechTokens, [0, 2, 4])
  t.is(params.greedy, false)
  t.exception(() => model('cosyvoice3', { forceSpeechTokens: [1.5] }), /invalid number/)
  t.exception(() => model('moss', { forceSpeechTokens: [1] }), /cosyvoice3-only/)
})

test('reload applies native controls together and rolls back rejected budgets', (t) => {
  const setup = resolveEngineSetup({ engine: 'moss', files: FILES.moss })
  const params = applyReloadableConfig(setup, {
    maxNewTokens: 4096,
    nCtx: 8192,
    durationTokens: 3000,
    textTemperature: 0,
    backend: 'Vulkan0'
  })
  t.is(params.maxNewTokens, 4096)
  t.is(params.durationTokens, 3000)
  t.is(params.textTemperature, 0)
  t.is(params.backend, 'Vulkan0')
  t.exception(
    () => applyReloadableConfig(setup, { maxNewTokens: 100, backend: 'cpu' }),
    /durationTokens/
  )
  t.is(setup.settings.maxNewTokens, 4096)
  t.is(setup.config.backend, 'Vulkan0')
})

class WarmUpBinding extends MockedBinding {
  runJob(handle, data) {
    if (data.type !== 'warmUp') return super.runJob(handle, data)
    this.lastWarmUp = data.input
    setImmediate(() => this._callCallbacks('RuntimeStats', { totalTime: 0 }, null))
    return true
  }
}

test('Supertonic warmUp dispatches native work without generating output', async (t) => {
  const instance = model('supertonic')
  const binding = new WarmUpBinding()
  instance._createAddon = (params, callback) => new TTSInterface(binding, params, callback)
  await instance.load()
  t.is(await instance.warmUp('Warm this text.'), undefined)
  t.is(binding.lastWarmUp, 'Warm this text.')
  t.absent(instance._job.active)
  await instance.destroy()
  await t.exception(model('pocket').warmUp('Unsupported'), /Supertonic/)
  await t.exception(model('supertonic').warmUp(1), /string/)
})
