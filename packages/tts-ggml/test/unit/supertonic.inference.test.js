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
  t.is(params.nGpuLayers, 0, 'nGpuLayers=0 is the only allowed GPU value for supertonic today')
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
