'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const sinon = require('sinon')
const process = require('process')

global.process = process

function createMockedMtlModel ({
  onOutput = () => {},
  binding,
  language = 'es',
  files,
  exclusiveRun = false,
  extra = {}
} = {}) {
  const model = new TTSGgml({
    files: files || {
      t3Model: './models/chatterbox-t3-mtl.gguf',
      s3genModel: './models/chatterbox-s3gen-mtl.gguf'
    },
    config: { language },
    opts: { stats: true },
    exclusiveRun,
    ...extra
  })

  sinon.stub(model, '_createAddon').callsFake((configurationParams, outputCb) => {
    const _binding = binding || new MockedBinding()
    const addon = new TTSInterface(_binding, configurationParams, outputCb)
    if (_binding.setBaseInferenceCallback) {
      _binding.setBaseInferenceCallback(onOutput)
    }
    return addon
  })
  return model
}

test('Chatterbox MTL: explicit MTL gguf paths route to chatterbox engine', (t) => {
  const model = createMockedMtlModel()
  t.is(model.getEngineType(), TTSGgml.ENGINE_CHATTERBOX, 'MTL gguf is still chatterbox')
  t.is(model._t3ModelPath, './models/chatterbox-t3-mtl.gguf')
  t.is(model._s3genModelPath, './models/chatterbox-s3gen-mtl.gguf')
})

test('Chatterbox MTL: language config is forwarded into ttsParams', async (t) => {
  for (const lang of ['es', 'fr', 'de', 'pt', 'it', 'zh', 'ja', 'ko']) {
    const model = createMockedMtlModel({ language: lang })
    const params = model._buildTtsParams()
    t.is(params.language, lang, `language ${lang} should be forwarded`)
    t.is(params.engineType, TTSGgml.ENGINE_CHATTERBOX, `language ${lang} keeps chatterbox engine`)
  }
})

test('Chatterbox MTL: synthesis returns audio output and stats with non-en language', async (t) => {
  const events = []
  const model = createMockedMtlModel({
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

test('Chatterbox MTL: cancel propagates as job failure', async (t) => {
  const model = createMockedMtlModel({ language: 'es' })
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

test('Chatterbox MTL: reload({ language }) swaps language without reloading weights from disk', async (t) => {
  const model = createMockedMtlModel({ language: 'es' })
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

test('Chatterbox MTL: modelDir auto-detects MTL gguf when only MTL files are present', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const tmpRoot = path.join(os.tmpdir(), 'tts-ggml-mtl-detect-' + Date.now())
  try {
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'chatterbox-t3-mtl.gguf'), 'mtl-marker')
    fs.writeFileSync(path.join(tmpRoot, 'chatterbox-s3gen-mtl.gguf'), 'mtl-marker')

    const model = new TTSGgml({
      files: { modelDir: tmpRoot },
      config: { language: 'es' }
    })
    t.is(
      model._t3ModelPath,
      path.join(tmpRoot, 'chatterbox-t3-mtl.gguf'),
      'MTL t3 wins when only MTL is present'
    )
    t.is(
      model._s3genModelPath,
      path.join(tmpRoot, 'chatterbox-s3gen-mtl.gguf'),
      'MTL s3gen wins when only MTL is present'
    )
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_e) {}
  }
})

test('Chatterbox MTL: modelDir prefers turbo over MTL when both are present', async (t) => {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const tmpRoot = path.join(os.tmpdir(), 'tts-ggml-mtl-mixed-' + Date.now())
  try {
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'chatterbox-t3-turbo.gguf'), 'turbo-marker')
    fs.writeFileSync(path.join(tmpRoot, 'chatterbox-t3-mtl.gguf'), 'mtl-marker')
    fs.writeFileSync(path.join(tmpRoot, 'chatterbox-s3gen.gguf'), 'turbo-marker')
    fs.writeFileSync(path.join(tmpRoot, 'chatterbox-s3gen-mtl.gguf'), 'mtl-marker')

    const model = new TTSGgml({
      files: { modelDir: tmpRoot },
      config: { language: 'en' }
    })
    t.is(
      model._t3ModelPath,
      path.join(tmpRoot, 'chatterbox-t3-turbo.gguf'),
      'turbo t3 wins over MTL when both are on disk'
    )
    t.is(
      model._s3genModelPath,
      path.join(tmpRoot, 'chatterbox-s3gen.gguf'),
      'turbo s3gen wins over MTL when both are on disk'
    )
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_e) {}
  }
})
