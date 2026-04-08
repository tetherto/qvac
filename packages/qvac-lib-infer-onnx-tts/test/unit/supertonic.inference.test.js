'use strict'

const test = require('brittle')
const ONNXTTS = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('process')

global.process = process
const sinon = require('sinon')

function createMockedSupertonicModel ({ onOutput = () => { }, binding = undefined } = {}) {
  const model = new ONNXTTS({
    files: {
      modelDir: './models/supertonic'
    },
    engine: 'supertonic',
    voiceName: 'F1',
    speed: 1,
    numInferenceSteps: 5,
    config: {
      language: 'en',
      useGPU: false
    },
    opts: { stats: true }
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

test('Supertonic: Inference returns correct output for text input', async (t) => {
  const events = []
  const model = createMockedSupertonicModel({
    onOutput: (addon, event, data, error) => events.push({ event, data, error })
  })
  await model.load()

  const response = await model.run({ type: 'text', input: 'Hello world' })
  const outputs = []
  await response.onUpdate(data => outputs.push(data)).await()

  t.ok(outputs.length > 0, 'Response should emit at least one output event')
  t.ok(outputs.some(d => d.outputArray), 'Output should contain audio samples')
  t.ok(response.stats.totalSamples > 0, 'Stats should include total samples')
  t.ok(events.length > 0, 'Raw callbacks should be captured')
  await model.unload()
})

test('Supertonic: Static methods return expected values', async (t) => {
  const modelKey = ONNXTTS.getModelKey({})
  t.is(modelKey, 'onnx-tts', 'getModelKey should return "onnx-tts"')

  t.ok(ONNXTTS.inferenceManagerConfig, 'inferenceManagerConfig should exist')
  t.is(ONNXTTS.inferenceManagerConfig.noAdditionalDownload, true, 'noAdditionalDownload should be true')
})

test('Supertonic: Engine type is detected correctly', async (t) => {
  const modelFromDir = new ONNXTTS({
    files: { modelDir: './models/supertonic' },
    voiceName: 'F1'
  })
  t.is(modelFromDir._engineType, 'supertonic', 'Should detect Supertonic engine when modelDir + voiceName are provided')

  const modelFromDirOnly = new ONNXTTS({
    files: { modelDir: './models/supertonic' }
  })
  t.is(
    modelFromDirOnly._engineType,
    'supertonic',
    'Should detect Supertonic when only modelDir is set (voiceName defaults to F1)'
  )
  t.is(modelFromDirOnly._voiceName, 'F1', 'Default voice when voiceName omitted')

  const modelDirWithVoicesDir = new ONNXTTS({
    files: {
      modelDir: './models/supertonic',
      voicesDir: '/custom/voice_styles'
    }
  })
  t.is(
    modelDirWithVoicesDir._engineType,
    'supertonic',
    'modelDir + voicesDir should resolve to Supertonic (voicesDir overrides path only, not engine detection)'
  )

  const modelFromPaths = new ONNXTTS({
    files: {
      textEncoder: './onnx/text_encoder.onnx',
      durationPredictor: './onnx/duration_predictor.onnx',
      vectorEstimator: './onnx/vector_estimator.onnx',
      vocoder: './onnx/vocoder.onnx'
    }
  })
  t.is(modelFromPaths._engineType, 'supertonic', 'Should detect Supertonic engine when textEncoder path is provided')
})

test('Supertonic: cancel propagates as job failure', async (t) => {
  const model = createMockedSupertonicModel()
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
