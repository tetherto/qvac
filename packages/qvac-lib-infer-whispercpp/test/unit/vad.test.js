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
 * Helper function to create test model with common configuration
 */
function createTestModel ({ onOutput = () => { }, vadModelPath = 'ggml-silero-v5.1.2.bin' } = {}) {
  // Restore any existing stub first
  TranscriptionWhispercpp.prototype.validateModelFiles?.restore?.()
  // Mock validateModelFiles on the prototype BEFORE creating instance
  sinon.stub(TranscriptionWhispercpp.prototype, 'validateModelFiles').returns(undefined)

  const args = {
    files: {
      model: 'ggml-tiny.bin',
      vadModel: vadModelPath
    }
  }
  const config = {
    vadModelPath,
    whisperConfig: {}
  }
  const model = new TranscriptionWhispercpp(args, config)
  let capturedConfigResolve
  const capturedConfig = new Promise(resolve => { capturedConfigResolve = resolve })
  sinon.stub(model, '_createAddon').callsFake(configurationParams => {
    capturedConfigResolve(configurationParams)
    const binding = new MockedBinding()
    binding.enableVadTestMode() // Enable VAD-specific test behavior
    return new WhisperInterface(binding, configurationParams, onOutput, transitionCb)
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

  // Simulate sending audio chunks with silence and speech
  const audioChunk1 = new Uint8Array([10, 20, 30, 40, 50]) // Speech
  const audioChunk2 = new Uint8Array([0, 0, 0, 0, 0]) // Silence
  const audioChunk3 = new Uint8Array([60, 70, 80, 90, 100]) // Speech

  const jobId1 = await model.addon.append({ type: 'audio', input: audioChunk1 })
  t.is(jobId1, 1, 'First job ID should be 1')

  const jobId2 = await model.addon.append({ type: 'audio', input: audioChunk2 })
  t.is(jobId2, 1, 'Job ID should remain 1 for same job')

  const jobId3 = await model.addon.append({ type: 'audio', input: audioChunk3 })
  t.is(jobId3, 1, 'Job ID should remain 1 for same job')

  // Append an end-of-job marker
  const jobIdEnd = await model.addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'Job ID should remain 1 for end-of-job signal')

  await wait()

  // Check that we received Output events with stronger assertions
  console.log(events)
  const outputEvents = events.filter(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvents.length > 0, 'Should receive Output events for VAD processing')

  if (outputEvents.length > 0) {
    t.ok(outputEvents[0].output, 'Should have transcription output')
    t.is(typeof outputEvents[0].output, 'object', 'Output should be transcript object')
    t.ok(outputEvents[0].output.text.includes('Mock transcription') ||
      outputEvents[0].output.text.includes('Silent audio detected'),
    'Should contain mock transcription or silence detection text')
  }

  // Check that we received a JobEnded event
  const jobEndedEvent = events.find(e => e.event === 'JobEnded' && e.jobId === 1)
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
  t.is(capturedConfig.whisperConfig.vad_model_path, 'ggml-silero-v5.1.2.bin', 'VAD model path should be correctly passed')
  t.is(capturedConfig.contextParams.model, 'ggml-tiny.bin', 'Model filename should be correctly passed')
})

test('VAD handles invalid audio input gracefully', async (t) => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const [model] = createTestModel({ onOutput })

  await model.load()

  // Test invalid append payloads - wrapper should reject these immediately.
  for (const invalidInput of [null, undefined, 'invalid']) {
    try {
      await model.addon.append({ type: 'audio', input: invalidInput })
      t.fail('Expected append to reject invalid input')
    } catch (error) {
      t.ok(error, 'Invalid input should throw')
    }
  }

  // Verify that the addon is still functional after errors
  const validAudio = new Uint8Array([1, 2, 3, 4, 5])
  await model.addon.append({ type: 'audio', input: validAudio })
  await model.addon.append({ type: 'end of job' })

  await wait()

  const outputEvents = events.filter(e => e.event === 'Output')
  t.ok(outputEvents.length > 0, 'Should still process valid audio after errors')
})
