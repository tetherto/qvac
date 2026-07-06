'use strict'

const test = require('brittle')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

function createMockedModel ({
  onOutput = () => { },
  binding = undefined,
  exclusiveRun = false
} = {}) {
  const model = new TTSGgml({
    files: {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf'
    },
    config: { language: 'en' },
    opts: { stats: true },
    exclusiveRun
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

async function waitWithTimeout (promise, timeoutMs, message) {
  let timeoutId
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

test('Chatterbox: run returns audio output and stats', async (t) => {
  const events = []
  const callbackArity = []
  const model = createMockedModel({
    onOutput: function (addon, event, data, error) {
      callbackArity.push(arguments.length)
      events.push({ event, data, error })
    }
  })
  await model.load()

  const response = await model.run({ type: 'text', input: 'Hello world' })
  const outputs = []
  await response.onUpdate(data => outputs.push(data)).await()

  t.ok(outputs.length > 0, 'Response should emit at least one update')
  t.ok(outputs.some(d => d.outputArray), 'Response should contain outputArray payload')
  t.ok(response.stats.totalSamples > 0, 'Response stats should include total samples')
  t.ok(events.length > 0, 'Raw addon callback should have been called')
  t.ok(callbackArity.every(length => length === 4), 'Native callbacks should not include a native jobId argument')
  await model.unload()
})

test('Chatterbox: exclusiveRun does not deadlock run()', async (t) => {
  const model = createMockedModel({ exclusiveRun: true })
  await model.load()

  const response = await waitWithTimeout(
    model.run({ type: 'text', input: 'Hello with exclusive run' }),
    1000,
    'run() timed out under exclusiveRun'
  )

  await waitWithTimeout(
    response.await(),
    1000,
    'response.await() timed out under exclusiveRun'
  )

  t.ok(response.stats.totalSamples > 0, 'Exclusive run should still produce runtime stats')
  await model.unload()
})

test('Chatterbox: reload reloads configuration', async (t) => {
  const model = createMockedModel()
  await model.load()

  const before = await model.run({ type: 'text', input: 'hello' })
  await before.await()

  await model.reload({ language: 'en' })
  const after = await model.run({ type: 'text', input: 'hello again' })
  await after.await()

  t.ok(after.stats.audioDurationMs > 0, 'Reloaded model should still produce stats')
  await model.unload()
})

test('Chatterbox: exclusiveRun does not deadlock reload() or unload()', async (t) => {
  const model = createMockedModel({ exclusiveRun: true })
  await model.load()

  await waitWithTimeout(
    model.reload({ language: 'en' }),
    1000,
    'reload() timed out under exclusiveRun'
  )

  const response = await waitWithTimeout(
    model.run({ type: 'text', input: 'after reload' }),
    1000,
    'run() after reload timed out under exclusiveRun'
  )
  await waitWithTimeout(
    response.await(),
    1000,
    'response.await() after reload timed out under exclusiveRun'
  )

  await waitWithTimeout(
    model.unload(),
    1000,
    'unload() timed out under exclusiveRun'
  )
  t.pass('exclusiveRun operations complete without deadlock')
})

test('Chatterbox: reload during in-flight job does not stay busy', async (t) => {
  const binding = new MockedBinding({ jobDelayMs: 100 })
  const model = createMockedModel({ binding })
  await model.load()

  const inFlight = await model.run({ type: 'text', input: 'hello before reload' })
  await model.reload({ language: 'en' })

  let rejected = false
  try {
    await inFlight.await()
  } catch (error) {
    rejected = true
    t.ok(String(error.message).includes('reloaded'), 'In-flight job should fail on reload')
  }
  t.ok(rejected, 'Reload should reject the in-flight response')

  // Let stale callbacks from the destroyed addon drain before submitting a new job.
  await new Promise(resolve => setTimeout(resolve, 150))

  const afterReload = await model.run({ type: 'text', input: 'hello after reload' })
  await afterReload.await()
  t.ok(afterReload.stats.totalSamples > 0, 'Model should accept and complete jobs after reload')

  await model.unload()
})

test('Chatterbox: static methods return expected values', async (t) => {
  const modelKey = TTSGgml.getModelKey({})
  t.is(modelKey, 'tts-ggml', 'getModelKey should return "tts-ggml"')
  t.ok(TTSGgml.inferenceManagerConfig, 'inferenceManagerConfig should exist')
  t.is(TTSGgml.inferenceManagerConfig.noAdditionalDownload, true, 'noAdditionalDownload should be true')
})

test('Chatterbox: modelDir fills in the two GGUF paths', async (t) => {
  const path = require('bare-path')
  const model = new TTSGgml({
    files: { modelDir: './models' }
  })
  t.is(
    model._t3ModelPath,
    path.join('./models', 'chatterbox-t3-turbo.gguf'),
    'modelDir derives T3 GGUF path'
  )
  t.is(
    model._s3genModelPath,
    path.join('./models', 'chatterbox-s3gen.gguf'),
    'modelDir derives S3Gen GGUF path'
  )
})

test('Chatterbox: explicit t3Model / s3genModel override modelDir defaults', async (t) => {
  const model = new TTSGgml({
    files: {
      modelDir: './models',
      t3Model: '/abs/custom-t3.gguf',
      s3genModel: '/abs/custom-s3gen.gguf'
    }
  })
  t.is(model._t3ModelPath, '/abs/custom-t3.gguf', 'explicit t3Model wins over modelDir')
  t.is(model._s3genModelPath, '/abs/custom-s3gen.gguf', 'explicit s3genModel wins over modelDir')
})

test('Chatterbox: cancel propagates as job failure', async (t) => {
  const model = createMockedModel()
  await model.load()

  const response = await model.run({ type: 'text', input: 'cancel me' })
  await response.cancel()

  let failed = false
  try {
    await response.await()
  } catch (error) {
    failed = true
    t.ok(String(error.message).includes('cancel'), 'Cancelled response should reject')
  }

  t.ok(failed, 'Cancelled response should fail')
  await model.unload()
})

test('Chatterbox: nCtx forwards to ttsParams; omitted when unset (QVAC-19557)', (t) => {
  const files = {
    t3Model: './models/chatterbox-t3-turbo.gguf',
    s3genModel: './models/chatterbox-s3gen.gguf'
  }

  const capped = new TTSGgml({ files, config: { language: 'en' }, nCtx: 1024 })
  t.is(capped._buildTtsParams().nCtx, 1024, 'explicit nCtx forwarded to the addon')

  const uncapped = new TTSGgml({ files, config: { language: 'en' }, nCtx: 0 })
  t.is(uncapped._buildTtsParams().nCtx, 0, 'nCtx=0 (full GGUF context escape hatch) forwarded as-is')

  const defaulted = new TTSGgml({ files, config: { language: 'en' } })
  t.absent(defaulted._buildTtsParams().nCtx, 'nCtx omitted when unset so the addon applies its 2048 default')
})

test('Chatterbox: kvCacheType forwards to ttsParams; omitted when unset (QVAC-19557)', (t) => {
  const files = {
    t3Model: './models/chatterbox-t3-turbo.gguf',
    s3genModel: './models/chatterbox-s3gen.gguf'
  }

  const explicit = new TTSGgml({ files, config: { language: 'en' }, kvCacheType: 'f32' })
  t.is(explicit._buildTtsParams().kvCacheType, 'f32', 'explicit kvCacheType forwarded to the addon')

  const defaulted = new TTSGgml({ files, config: { language: 'en' } })
  t.absent(defaulted._buildTtsParams().kvCacheType, 'kvCacheType omitted when unset so the addon applies its f16 default')
})

test('Chatterbox: enhancer GGUF path forwards lavasrEnhancerPath (no enhance flag)', (t) => {
  const files = {
    t3Model: './models/chatterbox-t3-turbo.gguf',
    s3genModel: './models/chatterbox-s3gen.gguf'
  }

  const enhanced = new TTSGgml({
    files: { ...files, lavasrEnhancer: '/abs/enh.gguf' },
    config: { language: 'en' }
  })
  const params = enhanced._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_CHATTERBOX, 'routes to chatterbox')
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf', 'enhancer GGUF path forwarded')
  t.absent(params.enhance, 'no separate enhance flag is forwarded')

  const plain = new TTSGgml({ files, config: { language: 'en' } })
  t.absent(plain._buildTtsParams().lavasrEnhancerPath, 'no enhancer params when absent')
})

test('Chatterbox: unknown enhancer.type is rejected at construction', (t) => {
  t.exception(
    () => new TTSGgml({
      files: {
        t3Model: './models/chatterbox-t3-turbo.gguf',
        s3genModel: './models/chatterbox-s3gen.gguf',
        lavasrEnhancer: '/abs/enh.gguf'
      },
      config: { language: 'en' },
      enhancer: { type: 'nope' }
    }),
    /unknown enhancer\.type/,
    'a typo in enhancer.type throws instead of silently disabling enhancement'
  )
})

test('Chatterbox: enhancer + streamChunkTokens forwards both (streaming enhancement)', (t) => {
  // Previously rejected; the addon now enhances each native-streaming chunk via
  // a sliding-window StreamingEnhancer, so both knobs must reach the addon.
  const model = new TTSGgml({
    files: {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf',
      lavasrEnhancer: '/abs/enh.gguf'
    },
    streamChunkTokens: 25,
    config: { language: 'en' }
  })
  const params = model._buildTtsParams()
  t.is(params.streamChunkTokens, 25, 'streamChunkTokens forwarded')
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf', 'enhancer path forwarded alongside streaming')
})

// === LavaSR denoiser param forwarding ===
// The denoiser mirrors the enhancer: enabled purely by the presence of a GGUF
// path, runs before the enhancer. The tts-cpp UL-UNAS forward is implemented in
// qvac-ext-lib-whisper.cpp PR #78; these tests exercise the JS wiring (path
// forwarding + validation) without loading a model.

test('Chatterbox: files.lavasrDenoiser forwards lavasrDenoiserPath', (t) => {
  const files = {
    t3Model: './models/chatterbox-t3-turbo.gguf',
    s3genModel: './models/chatterbox-s3gen.gguf'
  }
  const denoised = new TTSGgml({
    files: { ...files, lavasrDenoiser: '/abs/den.gguf' },
    config: { language: 'en' }
  })
  const params = denoised._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_CHATTERBOX, 'routes to chatterbox')
  t.is(params.lavasrDenoiserPath, '/abs/den.gguf', 'denoiser GGUF path forwarded')

  const plain = new TTSGgml({ files, config: { language: 'en' } })
  t.absent(plain._buildTtsParams().lavasrDenoiserPath, 'no denoiser params when absent')
})

test('Chatterbox: denoiserPath via denoiser block forwards the path', (t) => {
  const model = new TTSGgml({
    files: {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf'
    },
    config: { language: 'en' },
    denoiser: { type: 'lavasr', denoiserPath: '/abs/den.gguf' }
  })
  t.is(model._buildTtsParams().lavasrDenoiserPath, '/abs/den.gguf')
})

test('Chatterbox: unknown denoiser.type is rejected at construction', (t) => {
  t.exception(
    () => new TTSGgml({
      files: {
        t3Model: './models/chatterbox-t3-turbo.gguf',
        s3genModel: './models/chatterbox-s3gen.gguf',
        lavasrDenoiser: '/abs/den.gguf'
      },
      config: { language: 'en' },
      denoiser: { type: 'nope' }
    }),
    /unknown denoiser\.type/,
    'a typo in denoiser.type throws instead of silently disabling denoising'
  )
})

test('Chatterbox: denoiser + streamChunkTokens is rejected (streaming denoise is a follow-up)', (t) => {
  t.exception(
    () => new TTSGgml({
      files: {
        t3Model: './models/chatterbox-t3-turbo.gguf',
        s3genModel: './models/chatterbox-s3gen.gguf',
        lavasrDenoiser: '/abs/den.gguf'
      },
      streamChunkTokens: 25,
      config: { language: 'en' }
    }),
    /denoiser is not yet supported with Chatterbox native chunk streaming/,
    'denoiser + native chunk streaming throws (unlike the enhancer, which supports it)'
  )
})

test('Chatterbox: denoiser and enhancer forward both paths (denoise before enhance)', (t) => {
  const model = new TTSGgml({
    files: {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf',
      lavasrEnhancer: '/abs/enh.gguf',
      lavasrDenoiser: '/abs/den.gguf'
    },
    config: { language: 'en' }
  })
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, '/abs/enh.gguf', 'enhancer path forwarded')
  t.is(params.lavasrDenoiserPath, '/abs/den.gguf', 'denoiser path forwarded alongside enhancer')
})

test('Chatterbox: outputSampleRate forwards to ttsParams; omitted when unset', (t) => {
  const files = {
    t3Model: './models/chatterbox-t3-turbo.gguf',
    s3genModel: './models/chatterbox-s3gen.gguf'
  }

  const withRate = new TTSGgml({ files, config: { language: 'en', outputSampleRate: 22050 } })
  t.is(withRate._buildTtsParams().outputSampleRate, 22050, 'outputSampleRate forwarded to native params')

  const noRate = new TTSGgml({ files, config: { language: 'en' } })
  t.absent(noRate._buildTtsParams().outputSampleRate, 'no outputSampleRate when unset')
})
