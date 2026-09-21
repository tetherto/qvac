'use strict'

const test = require('brittle')
const MockedBinding = require('../mocks/MockedBinding.js')
const { wait } = require('../mocks/utils.js')
const { MODEL_PATH, createWhisperModel, getAddon } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

function createTestModel({ onOutput = () => {}, vadModelPath = MODEL_PATH } = {}) {
  const binding = new MockedBinding()
  binding.enableVadTestMode()

  const { model, capturedConfig } = createWhisperModel({
    binding,
    onOutput,
    files: { model: MODEL_PATH, vadModel: vadModelPath },
    config: {
      vadModelPath,
      whisperConfig: {}
    }
  })
  return [model, capturedConfig]
}

test('VAD mode processes audio with voice activity detection', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model] = createTestModel({ onOutput })

  await model.load()
  const addon = getAddon(model)

  // Simulate sending audio chunks with silence and speech
  const audioChunk1 = new Uint8Array([10, 20, 30, 40, 50]) // Speech
  const audioChunk2 = new Uint8Array([0, 0, 0, 0, 0]) // Silence
  const audioChunk3 = new Uint8Array([60, 70, 80, 90, 100]) // Speech

  const jobId1 = await addon.append({ type: 'audio', input: audioChunk1 })
  t.is(jobId1, 1, 'First job ID should be 1')

  const jobId2 = await addon.append({ type: 'audio', input: audioChunk2 })
  t.is(jobId2, 1, 'Job ID should remain 1 for same job')

  const jobId3 = await addon.append({ type: 'audio', input: audioChunk3 })
  t.is(jobId3, 1, 'Job ID should remain 1 for same job')

  // Append an end-of-job marker
  const jobIdEnd = await addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'Job ID should remain 1 for end-of-job signal')

  await wait()

  // Check that we received Output events with stronger assertions
  console.log(events)
  const outputEvents = events.filter((e) => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvents.length > 0, 'Should receive Output events for VAD processing')

  if (outputEvents.length > 0) {
    t.ok(outputEvents[0].output, 'Should have transcription output')
    t.ok(Array.isArray(outputEvents[0].output), 'Output should be wrapped in array')
    const transcript = outputEvents[0].output[0]
    t.ok(
      transcript.text.includes('Mock transcription') ||
        transcript.text.includes('Silent audio detected'),
      'Should contain mock transcription or silence detection text'
    )
  }

  // Check that we received a JobEnded event
  const jobEndedEvent = events.find((e) => e.event === 'JobEnded' && e.jobId === 1)
  t.ok(jobEndedEvent, 'Should receive a JobEnded event for job 1')
})

/**
 * Test that VAD configuration is properly passed to the addon
 */
test('VAD model path is correctly configured', async (t) => {
  const [model, capturedConfigFut] = createTestModel()

  await model.load()
  const capturedConfig = await capturedConfigFut

  t.ok(capturedConfig, 'Configuration should be captured')
  t.is(
    capturedConfig.whisperConfig.vad_model_path,
    MODEL_PATH,
    'VAD model path should be correctly passed'
  )
  t.is(capturedConfig.contextParams.model, MODEL_PATH, 'Model filename should be correctly passed')
  t.is(
    capturedConfig.engineType,
    'whisper',
    'The unified createInstance dispatch key should be stamped'
  )
})

test('VAD handles invalid audio input gracefully', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model] = createTestModel({ onOutput })

  await model.load()
  const addon = getAddon(model)

  // Test invalid append payloads - wrapper should reject these immediately.
  for (const invalidInput of [null, undefined, 'invalid']) {
    try {
      await addon.append({ type: 'audio', input: invalidInput })
      t.fail('Expected append to reject invalid input')
    } catch (error) {
      t.ok(error, 'Invalid input should throw')
    }
  }

  // Verify that the addon is still functional after errors
  const validAudio = new Uint8Array([1, 2, 3, 4, 5])
  await addon.append({ type: 'audio', input: validAudio })
  await addon.append({ type: 'end of job' })

  await wait()

  const outputEvents = events.filter((e) => e.event === 'Output')
  t.ok(outputEvents.length > 0, 'Should still process valid audio after errors')
})
