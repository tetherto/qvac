'use strict'

const test = require('brittle')
const TranscriptionWhispercpp = require('../../index.js')
const MockedBinding = require('../mocks/MockedBinding.js')
const { wait, transitionCb } = require('../mocks/utils.js')
const { WhisperInterface } = require('../../whisper')

const process = require('process')
global.process = process
const sinon = require('sinon')

/**
 * Helper function to create test model with common configuration (no VAD)
 */
function createTestModel ({ onOutput = () => { }, binding = undefined } = {}) {
  // Restore any existing stub first
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()
  const args = {
    files: {
      model: 'ggml-tiny.bin'
    }
  }
  const config = {
    whisperConfig: {
      language: 'en',
      temperature: 0.0
    }
  }
  sinon.stub(TranscriptionWhispercpp.prototype, 'validateModelFiles').returns(undefined)
  const model = new TranscriptionWhispercpp(args, config)
  let capturedConfigResolve
  const capturedConfig = new Promise(resolve => { capturedConfigResolve = resolve })
  sinon.stub(model, '_createAddon').callsFake(configurationParams => {
    capturedConfigResolve(configurationParams)
    const _binding = binding || new MockedBinding()
    return new WhisperInterface(_binding, configurationParams, onOutput, transitionCb)
  })
  return [model, capturedConfig]
}

test('Reload method updates configuration without VAD', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model, capturedConfigFut] = createTestModel({ onOutput })

  await model.load()
  const initialConfig = await capturedConfigFut

  // Verify initial configuration
  t.ok(initialConfig, 'Initial configuration should be captured')
  t.is(initialConfig.contextParams.model, 'ggml-tiny.bin', 'Model filename should be correctly set')
  t.is(initialConfig.whisperConfig.language, 'en', 'Language should be set to en')
  t.is(initialConfig.whisperConfig.temperature, 0.0, 'Temperature should be set to 0.0')
  t.is(initialConfig.whisperConfig.vad_model_path, undefined, 'VAD model path should not be set')

  // Test reload with new configuration
  const newConfig = {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'es',
      temperature: 0.5,
      duration_ms: 15000
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  // Mock the addon's reload method
  const reloadSpy = sinon.spy(model.addon, 'reload')

  await model.addon.reload(newConfig)

  t.ok(reloadSpy.calledOnce, 'Reload method should be called once')
  t.ok(reloadSpy.calledWith(newConfig), 'Reload should be called with new configuration')
})

test('Reload method handles configuration changes correctly', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model] = createTestModel({ onOutput })

  await model.load()

  // Test processing audio before reload
  const audioChunk1 = new Uint8Array([10, 20, 30, 40, 50])
  const jobId1 = await model.addon.append({ type: 'audio', input: audioChunk1 })
  t.is(jobId1, 1, 'First job ID should be 1')

  await model.addon.append({ type: 'end of job' })
  await wait()

  // Verify initial processing worked
  const initialOutputEvents = events.filter(e => e.event === 'Output' && e.jobId === 1)
  t.ok(initialOutputEvents.length > 0, 'Should receive Output events before reload')

  // Clear events for reload test
  events.length = 0

  // Reload with new configuration
  const newConfig = {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'fr',
      temperature: 0.2,
      duration_ms: 20000
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  await model.addon.reload(newConfig)

  // Activate after reload
  await model.addon.activate()

  // Test processing audio after reload
  const audioChunk2 = new Uint8Array([60, 70, 80, 90, 100])
  const jobId2 = await model.addon.append({ type: 'audio', input: audioChunk2 })
  t.is(jobId2, 2, 'Job ID should increment to 2 after reload')

  await model.addon.append({ type: 'end of job' })
  await wait()

  // Verify processing still works after reload
  const reloadOutputEvents = events.filter(e => e.event === 'Output' && e.jobId === 2)
  t.ok(reloadOutputEvents.length > 0, 'Should receive Output events after reload')
})

test('Reload method validates configuration parameters', async (t) => {
  const [model] = createTestModel()

  await model.load()

  // Test with invalid configuration (missing required fields)
  const invalidConfig = {
    whisperConfig: {
      language: 'en'
      // Missing contextParams and miscConfig
    }
  }

  try {
    await model.addon.reload(invalidConfig)
    t.fail('Should throw error for invalid configuration')
  } catch (error) {
    t.ok(error, 'Should throw error for invalid configuration')
  }
})

test('Reload method maintains addon state correctly', async (t) => {
  const [model] = createTestModel()

  await model.load()

  // Verify initial state
  let status = await model.addon.status()
  t.ok(status === 'listening', 'Initial status should be listening')

  // Reload configuration
  const newConfig = {
    contextParams: {
      model: 'ggml-tiny.bin'
    },
    whisperConfig: {
      language: 'de',
      temperature: 0.1
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  await model.addon.reload(newConfig)

  // Verify state after reload
  status = await model.addon.status()
  t.ok(status === 'idle' || status === 'loading', 'Status should be idle or loading after reload')

  // Activate after reload
  await model.addon.activate()
  status = await model.addon.status()
  t.ok(status === 'listening', 'Status should be listening after activation')
})

test('Reload method handles multiple reloads correctly', async (t) => {
  const [model] = createTestModel()

  await model.load()

  // First reload
  const config1 = {
    contextParams: { model: 'ggml-tiny.bin' },
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  await model.addon.reload(config1)
  let status = await model.addon.status()
  t.ok(status === 'idle' || status === 'loading', 'Status should be idle or loading after first reload')

  await model.addon.activate()
  status = await model.addon.status()
  t.ok(status === 'listening', 'Status should be listening after first reload activation')

  // Second reload
  const config2 = {
    contextParams: { model: 'ggml-tiny.bin' },
    whisperConfig: { language: 'es', temperature: 0.5 },
    miscConfig: { caption_enabled: false }
  }

  await model.addon.reload(config2)
  status = await model.addon.status()
  t.ok(status === 'idle' || status === 'loading', 'Status should be idle or loading after second reload')

  await model.addon.activate()
  status = await model.addon.status()
  t.ok(status === 'listening', 'Status should be listening after second reload activation')
})

test('Reload method works with different language settings', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model] = createTestModel({ onOutput })

  await model.load()

  // Test with English configuration
  const englishConfig = {
    contextParams: { model: 'ggml-tiny.bin' },
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  await model.addon.reload(englishConfig)
  await model.addon.activate()

  // Process audio with English config
  const audioChunk = new Uint8Array([1, 2, 3, 4, 5])
  await model.addon.append({ type: 'audio', input: audioChunk })
  await model.addon.append({ type: 'end of job' })
  await wait()

  // Reload with Spanish configuration
  const spanishConfig = {
    contextParams: { model: 'ggml-tiny.bin' },
    whisperConfig: { language: 'es', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  await model.addon.reload(spanishConfig)
  await model.addon.activate()

  // Process audio with Spanish config
  const audioChunk2 = new Uint8Array([6, 7, 8, 9, 10])
  const jobId = await model.addon.append({ type: 'audio', input: audioChunk2 })
  t.is(jobId, 2, 'Job ID should increment after reload')

  await model.addon.append({ type: 'end of job' })
  await wait()

  // Verify processing works with different language
  const outputEvents = events.filter(e => e.event === 'Output' && e.jobId === 2)
  t.ok(outputEvents.length > 0, 'Should process audio with Spanish configuration')
})
