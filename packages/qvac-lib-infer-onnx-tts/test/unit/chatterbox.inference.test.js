'use strict'

const path = require('bare-path')
const test = require('brittle')
const ONNXTTS = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('process')

global.process = process
const sinon = require('sinon')

function createMockedChatterboxModel ({ onOutput = () => { }, binding = undefined, exclusiveRun = false } = {}) {
  const model = new ONNXTTS({
    files: {
      modelDir: './models/chatterbox'
    },
    engine: 'chatterbox',
    config: {
      language: 'en',
      useGPU: false
    },
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
  const model = createMockedChatterboxModel({
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

test('Chatterbox: preserves Portuguese diacritics at JS binding boundary', async (t) => {
  const binding = new MockedBinding()
  const model = createMockedChatterboxModel({ binding })
  const text = 'Olá mundo! Essa é uma demonstração de síntese de texto para voz usando Chatterbox'

  await model.load()
  const response = await model.run({ type: 'text', input: text })
  await response.await()

  t.is(binding.lastRunJob?.input, text, 'Binding should receive the exact UTF-8 string')
  await model.unload()
})

test('Chatterbox: exclusiveRun does not deadlock run()', async (t) => {
  const model = createMockedChatterboxModel({ exclusiveRun: true })
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

test('Chatterbox: Reload reloads configuration', async (t) => {
  const model = createMockedChatterboxModel()
  await model.load()

  const before = await model.run({ type: 'text', input: 'hello' })
  await before.await()

  await model.reload({ language: 'es' })
  const after = await model.run({ type: 'text', input: 'hola' })
  await after.await()

  t.ok(after.stats.audioDurationMs > 0, 'Reloaded model should still produce stats')
  await model.unload()
})

test('Chatterbox: exclusiveRun does not deadlock reload() or unload()', async (t) => {
  const model = createMockedChatterboxModel({ exclusiveRun: true })
  await model.load()

  await waitWithTimeout(
    model.reload({ language: 'es' }),
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
  const model = createMockedChatterboxModel({ binding })
  await model.load()

  const inFlight = await model.run({ type: 'text', input: 'hello before reload' })
  await model.reload({ language: 'es' })

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

test('Chatterbox: Static methods return expected values', async (t) => {
  const modelKey = ONNXTTS.getModelKey({})
  t.is(modelKey, 'onnx-tts', 'getModelKey should return "onnx-tts"')
  t.ok(ONNXTTS.inferenceManagerConfig, 'inferenceManagerConfig should exist')
  t.is(ONNXTTS.inferenceManagerConfig.noAdditionalDownload, true, 'noAdditionalDownload should be true')
})

test('Chatterbox: Engine type is detected correctly', async (t) => {
  const chatterboxModel = new ONNXTTS({
    files: {
      tokenizer: './tokenizer.json',
      speechEncoder: './speech_encoder.onnx',
      embedTokens: './embed_tokens.onnx',
      conditionalDecoder: './conditional_decoder.onnx',
      languageModel: './language_model.onnx'
    }
  })
  t.is(chatterboxModel._engineType, 'chatterbox', 'Should detect Chatterbox engine when Chatterbox paths are provided')

  const fromBundle = new ONNXTTS({
    files: { modelDir: './models/chatterbox' },
    engine: 'chatterbox'
  })
  t.is(fromBundle._engineType, 'chatterbox', 'engine chatterbox + modelDir uses Chatterbox layout')
  t.is(
    fromBundle._tokenizerPath,
    path.join('./models/chatterbox', 'tokenizer.json'),
    'modelDir derives tokenizer path'
  )
})

test('Chatterbox: invalid engine throws', async (t) => {
  t.exception(
    () => new ONNXTTS({ files: { modelDir: './x' }, engine: 'other' }),
    /invalid engine/
  )
})

test('Chatterbox: cancel propagates as job failure', async (t) => {
  const model = createMockedChatterboxModel()
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
