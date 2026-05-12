'use strict'

const test = require('brittle')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('process')

global.process = process
const sinon = require('sinon')

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
