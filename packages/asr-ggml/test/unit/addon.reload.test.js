'use strict'

const test = require('brittle')
const MockedBinding = require('../mocks/MockedBinding.js')
const { wait } = require('../mocks/utils.js')
const { MODEL_PATH, createWhisperModel, getAddon } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

function createTestModel({ onOutput = () => {}, binding = undefined } = {}) {
  const { model, capturedConfig } = createWhisperModel({
    binding: binding || new MockedBinding(),
    onOutput,
    files: { model: MODEL_PATH },
    config: {
      whisperConfig: {
        language: 'en',
        temperature: 0.0
      }
    }
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
  const addon = getAddon(model)

  // Verify initial configuration
  t.ok(initialConfig, 'Initial configuration should be captured')
  t.is(initialConfig.contextParams.model, MODEL_PATH, 'Model filename should be correctly set')
  t.is(initialConfig.whisperConfig.language, 'en', 'Language should be set to en')
  t.is(initialConfig.whisperConfig.temperature, 0.0, 'Temperature should be set to 0.0')
  t.is(initialConfig.whisperConfig.vad_model_path, undefined, 'VAD model path should not be set')

  // Test reload with new configuration
  const newConfig = {
    contextParams: {
      model: MODEL_PATH
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

  let reloadCallCount = 0
  let reloadCallArg = null
  const origReload = addon.reload.bind(addon)
  addon.reload = async (...args) => {
    reloadCallCount++
    reloadCallArg = args[0]
    return origReload(...args)
  }

  await addon.reload(newConfig)

  t.is(reloadCallCount, 1, 'Reload method should be called once')
  t.is(reloadCallArg, newConfig, 'Reload should be called with new configuration')
})

test('Reload method handles configuration changes correctly', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model] = createTestModel({ onOutput })

  await model.load()
  const addon = getAddon(model)

  // Test processing audio before reload
  const audioChunk1 = new Uint8Array([10, 20, 30, 40, 50])
  const jobId1 = await addon.append({ type: 'audio', input: audioChunk1 })
  t.is(jobId1, 1, 'First job ID should be 1')

  await addon.append({ type: 'end of job' })
  await wait()

  // Verify initial processing worked
  const initialOutputEvents = events.filter((e) => e.event === 'Output' && e.jobId === 1)
  t.ok(initialOutputEvents.length > 0, 'Should receive Output events before reload')

  // Clear events for reload test
  events.length = 0

  // Reload with new configuration
  const newConfig = {
    contextParams: {
      model: MODEL_PATH
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

  await addon.reload(newConfig)

  // Activate after reload
  await addon.activate()

  // Test processing audio after reload
  const audioChunk2 = new Uint8Array([60, 70, 80, 90, 100])
  const jobId2 = await addon.append({ type: 'audio', input: audioChunk2 })
  t.is(jobId2, 2, 'Job ID should increment to 2 after reload')

  await addon.append({ type: 'end of job' })
  await wait()

  // Verify processing still works after reload
  const reloadOutputEvents = events.filter((e) => e.event === 'Output' && e.jobId === 2)
  t.ok(reloadOutputEvents.length > 0, 'Should receive Output events after reload')
})

test('Reload method validates configuration parameters', async (t) => {
  const [model] = createTestModel()

  await model.load()
  const addon = getAddon(model)

  // Test with invalid configuration (missing required fields)
  const invalidConfig = {
    whisperConfig: {
      language: 'en'
      // Missing contextParams and miscConfig
    }
  }

  try {
    await addon.reload(invalidConfig)
    t.fail('Should throw error for invalid configuration')
  } catch (error) {
    t.ok(error, 'Should throw error for invalid configuration')
  }
})

test('Reload method maintains addon state correctly', async (t) => {
  const [model] = createTestModel()

  await model.load()
  const addon = getAddon(model)

  // Verify initial state
  let status = await addon.status()
  t.ok(status === 'listening', 'Initial status should be listening')

  // Reload configuration
  const newConfig = {
    contextParams: {
      model: MODEL_PATH
    },
    whisperConfig: {
      language: 'de',
      temperature: 0.1
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  await addon.reload(newConfig)

  // Verify state after reload
  status = await addon.status()
  t.ok(status === 'idle' || status === 'loading', 'Status should be idle or loading after reload')

  // Activate after reload
  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be listening after activation')
})

test('Reload method handles multiple reloads correctly', async (t) => {
  const [model] = createTestModel()

  await model.load()
  const addon = getAddon(model)

  // First reload
  const config1 = {
    contextParams: { model: MODEL_PATH },
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  await addon.reload(config1)
  let status = await addon.status()
  t.ok(
    status === 'idle' || status === 'loading',
    'Status should be idle or loading after first reload'
  )

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be listening after first reload activation')

  // Second reload
  const config2 = {
    contextParams: { model: MODEL_PATH },
    whisperConfig: { language: 'es', temperature: 0.5 },
    miscConfig: { caption_enabled: false }
  }

  await addon.reload(config2)
  status = await addon.status()
  t.ok(
    status === 'idle' || status === 'loading',
    'Status should be idle or loading after second reload'
  )

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be listening after second reload activation')
})

test('Reload method works with different language settings', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model] = createTestModel({ onOutput })

  await model.load()
  const addon = getAddon(model)

  // Test with English configuration
  const englishConfig = {
    contextParams: { model: MODEL_PATH },
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  await addon.reload(englishConfig)
  await addon.activate()

  // Process audio with English config
  const audioChunk = new Uint8Array([1, 2, 3, 4, 5])
  await addon.append({ type: 'audio', input: audioChunk })
  await addon.append({ type: 'end of job' })
  await wait()

  // Reload with Spanish configuration
  const spanishConfig = {
    contextParams: { model: MODEL_PATH },
    whisperConfig: { language: 'es', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }

  await addon.reload(spanishConfig)
  await addon.activate()

  // Process audio with Spanish config
  const audioChunk2 = new Uint8Array([6, 7, 8, 9, 10])
  const jobId = await addon.append({ type: 'audio', input: audioChunk2 })
  t.is(jobId, 2, 'Job ID should increment after reload')

  await addon.append({ type: 'end of job' })
  await wait()

  // Verify processing works with different language
  const outputEvents = events.filter((e) => e.event === 'Output' && e.jobId === 2)
  t.ok(outputEvents.length > 0, 'Should process audio with Spanish configuration')
})
