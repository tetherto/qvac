'use strict'

const test = require('brittle')
const process = require('bare-process')
const { resolveEngineSetup } = require('../../lib/setup.js')
const { applyParlerReload, buildParlerParams } = require('../../lib/engines/parler.js')
const { applyReloadableConfig } = require('../../lib/reload.js')
const { buildNativeParams } = require('../../lib/engineParams.js')

global.process = process

function parlerSetup(extra = {}) {
  return resolveEngineSetup({
    engine: 'parler',
    files: { parlerModel: './models/parler-mini-v1-q8_0.gguf' },
    ...extra
  })
}

test('parler config: construction collapses the description alias and maps the fields natively', (t) => {
  const setup = parlerSetup({ voiceDescription: 'A warm voice.', temperature: 0.7 })
  t.is(setup.settings.description, 'A warm voice.')
  const params = buildParlerParams(setup)
  t.is(params.engineType, 'parler')
  t.is(params.description, 'A warm voice.')
  t.is(params.temperature, 0.7)
  t.absent(params.voice, 'no template field is set')
})

test('parler config: reload rewrites description, template and sampler fields the same way', (t) => {
  const setup = parlerSetup({ voice: 'Rohit', topK: 10 })
  applyParlerReload(setup, {
    voiceDescription: 'Calm.',
    voice: undefined,
    pitch: 'low',
    topP: 0.5,
    seed: 3,
    normalizeNumbers: false
  })
  t.is(setup.settings.description, 'Calm.', 'voiceDescription reloads as description')
  t.is(setup.settings.voice, 'Rohit', 'an undefined key leaves the field alone')
  t.is(setup.settings.pitch, 'low')
  t.is(setup.settings.topP, 0.5)
  t.is(setup.settings.seed, 3)
  t.is(setup.settings.normalizeNumbers, false)
  t.is(setup.settings.topK, 10, 'untouched sampler knobs survive')
  t.exception(
    () => buildParlerParams(setup),
    /mutually exclusive/,
    'the builder re-checks description against the template after a reload'
  )
})

test('parler config: reload on another engine ignores the Parler keys', (t) => {
  const setup = resolveEngineSetup({
    files: {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf'
    }
  })
  applyParlerReload(setup, { description: 'ignored', pitch: 'low' })
  t.absent(setup.settings.description)
  t.absent(setup.settings.pitch)
})

test('reload: a rejected reload restores settings, runtime config and the output rate', (t) => {
  const setup = parlerSetup({
    description: 'A calm voice.',
    config: { language: 'en', outputSampleRate: 24000 }
  })
  const before = { ...setup.settings }
  t.exception(
    () =>
      applyReloadableConfig(setup, {
        language: 'fr',
        useGPU: true,
        outputSampleRate: 44100,
        pitch: 'high'
      }),
    /mutually exclusive/
  )
  t.alike(setup.settings, before, 'every setting is back')
  t.is(setup.config.language, 'en')
  t.is(setup.config.useGPU, false)
  t.is(setup.outputSampleRate, 24000)

  const params = applyReloadableConfig(setup, { language: 'fr', outputSampleRate: 44100 })
  t.is(setup.config.language, 'fr', 'an accepted reload lands')
  t.is(params.outputSampleRate, 44100)
  t.alike(params, buildNativeParams(setup), 'the returned params describe the live setup')
})

test('parler Core ML: omitted fields inherit, explicit false survives constructor and reload', (t) => {
  const setup = parlerSetup()
  for (const key of ['coremlDecoder', 'coremlComputeUnits', 'coremlStrict']) {
    t.is(Object.hasOwn(buildParlerParams(setup), key), false, key + ' stays omitted')
  }
  for (const units of ['all', 'cpu_and_ane', 'cpu_and_gpu', 'cpu_only']) {
    const explicit = parlerSetup({
      coremlDecoder: false,
      coremlStrict: false,
      coremlComputeUnits: units
    })
    const params = buildParlerParams(explicit)
    t.is(params.coremlDecoder, false)
    t.is(params.coremlStrict, false)
    t.is(params.coremlComputeUnits, units)
  }
  const enabled = applyReloadableConfig(setup, {
    coremlDecoder: true,
    coremlStrict: true,
    coremlComputeUnits: 'cpu_and_ane'
  })
  t.is(enabled.coremlDecoder, true)
  t.is(enabled.coremlStrict, true)
  const disabled = applyReloadableConfig(setup, { coremlDecoder: false, coremlStrict: false })
  t.is(disabled.coremlDecoder, false)
  t.is(disabled.coremlStrict, false)
  t.is(disabled.coremlComputeUnits, 'cpu_and_ane')
  t.alike(applyReloadableConfig(setup, { coremlStrict: undefined }), disabled)
})

test('parler Core ML: invalid values reject at construction and reload rolls back all changes', (t) => {
  const setup = parlerSetup({
    coremlDecoder: true,
    coremlStrict: true,
    coremlComputeUnits: 'all',
    temperature: 0.7
  })
  const before = buildParlerParams(setup)
  for (const [key, values] of [
    ['coremlDecoder', [null, 0, 1, 'false', 'true', {}]],
    ['coremlStrict', [null, 0, 1, 'false', 'true', {}]],
    ['coremlComputeUnits', [null, false, 1, '', 'ane', 'ALL', {}]]
  ]) {
    for (const value of values) {
      t.exception(() => parlerSetup({ [key]: value }), new RegExp(key))
      t.exception(
        () =>
          applyReloadableConfig(setup, { temperature: 0.3, coremlDecoder: false, [key]: value }),
        new RegExp(key)
      )
      t.alike(buildParlerParams(setup), before, 'rejected reload preserves the native config')
    }
  }
  t.exception(
    () =>
      applyReloadableConfig(setup, { coremlStrict: false, description: 'A voice.', pitch: 'low' }),
    /mutually exclusive/
  )
  t.alike(buildParlerParams(setup), before, 'later validation also rolls back Core ML changes')
})

test('parler Core ML: other engines reject constructor and reload options including false', (t) => {
  for (const engine of [
    'chatterbox',
    'supertonic',
    'cosyvoice3',
    'audio8',
    'moss',
    'moss-sfx',
    'moss-speech',
    'pocket'
  ]) {
    for (const fields of [
      { coremlDecoder: false },
      { coremlStrict: false },
      { coremlComputeUnits: 'cpu_only' }
    ]) {
      t.exception(() => resolveEngineSetup({ engine, ...fields }), /parler-only|does not support/)
      const setup = resolveEngineSetup({
        engine,
        files: {
          mossSoundEffect: './moss-sfx.gguf',
          mossSpeechModel: './moss-speech.gguf',
          mossSpeechCodec: './moss-codec.gguf',
          pocketFlowModel: './flow.gguf',
          pocketMimiModel: './mimi.gguf',
          pocketFrontend: './frontend.json',
          pocketVoice: './voice.gguf'
        }
      })
      const before = { ...setup.settings }
      t.exception(() => applyReloadableConfig(setup, { language: 'fr', ...fields }), /parler-only/)
      t.alike(setup.settings, before)
      t.is(setup.config.language, undefined)
    }
  }
})
