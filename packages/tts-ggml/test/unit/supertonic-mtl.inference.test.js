'use strict'

// Supertonic multilingual unit coverage: same engine class as
// supertonic.inference.test.js but exercises the language knob to make
// sure non-en codes are forwarded through ttsParams + reload, and that
// the JS layer doesn't introduce a hidden 'en'-only allow-list (the
// real allow-list lives in tts-cpp's supertonic_preprocess.cpp and is
// already covered by the integration test).

const test = require('brittle')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

function createMockedSupertonicMtlModel ({
  onOutput = () => {},
  binding,
  language = 'es',
  voice = 'F1',
  files,
  exclusiveRun = false,
  extra = {}
} = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: files || { supertonicModel: './models/supertonic2.gguf' },
    voice,
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

test('Supertonic MTL: language config is forwarded into ttsParams', (t) => {
  for (const lang of ['en', 'ko', 'es', 'pt', 'fr']) {
    const model = createMockedSupertonicMtlModel({ language: lang })
    const params = model._buildTtsParams()
    t.is(params.language, lang, `language ${lang} should be forwarded`)
    t.is(params.engineType, TTSGgml.ENGINE_SUPERTONIC, `language ${lang} keeps supertonic engine`)
  }
})

test('Supertonic MTL: synthesis returns audio output and stats with non-en language', async (t) => {
  const events = []
  const model = createMockedSupertonicMtlModel({
    language: 'fr',
    onOutput: (addon, event, data, error) => events.push({ event, data, error })
  })
  await model.load()

  const response = await model.run({ type: 'text', input: 'Bonjour le monde.' })
  const outputs = []
  await response.onUpdate(d => outputs.push(d)).await()

  t.ok(outputs.length > 0, 'MTL run emits at least one update')
  t.ok(outputs.some(d => d.outputArray), 'MTL output has outputArray')
  t.ok(response.stats.totalSamples > 0, 'MTL stats include totalSamples')
  t.ok(events.length > 0, 'raw addon callback fired for MTL run')
  await model.unload()
})

test('Supertonic MTL: cancel propagates as job failure', async (t) => {
  const model = createMockedSupertonicMtlModel({ language: 'es' })
  await model.load()

  const response = await model.run({ type: 'text', input: 'Cancelar esto' })
  await response.cancel()

  let failed = false
  try {
    await response.await()
  } catch (error) {
    failed = true
    t.ok(String(error.message).includes('cancel'), 'cancelled MTL response rejects')
  }
  t.ok(failed, 'cancelled MTL response should fail')
  await model.unload()
})

test('Supertonic MTL: reload({ language }) swaps language without reloading weights from disk', async (t) => {
  const model = createMockedSupertonicMtlModel({ language: 'es' })
  await model.load()

  const r1 = await model.run({ type: 'text', input: 'Hola' })
  await r1.await()

  await model.reload({ language: 'fr' })
  t.is(model._config.language, 'fr', 'language updated to fr')

  const r2 = await model.run({ type: 'text', input: 'Bonjour' })
  await r2.await()
  t.ok(r2.stats.totalSamples > 0, 'reloaded MTL model produces audio')
  await model.unload()
})

test('Supertonic MTL: voice + language together survive ttsParams round-trip', (t) => {
  const model = createMockedSupertonicMtlModel({
    language: 'pt',
    voice: 'M2',
    extra: { steps: 6, speed: 1.1, seed: 13 }
  })
  const params = model._buildTtsParams()
  t.is(params.language, 'pt')
  t.is(params.voice, 'M2')
  t.is(params.steps, 6)
  t.is(params.speed, 1.1)
  t.is(params.seed, 13)
  t.is(params.useGPU, false, 'useGPU defaults to false when unspecified')
})
