'use strict'

/**
 * JS plumbing for the speech-cpp capabilities the parakeet binding exposes:
 * the new parakeetConfig keys and per-call streaming overrides reach the
 * binding verbatim, and a native VAD payload surfaces as a typed VadEvent.
 */

const test = require('brittle')
const ASRGgml = require('../../index.js')
const MockedBinding = require('../mocks/ParakeetMockedBinding.js')
const { MODEL_PATH, getDriver, createParakeetModel, pushable } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

function buildParams(parakeetConfig = {}) {
  const model = new ASRGgml({
    files: { model: MODEL_PATH },
    config: { engine: 'parakeet', parakeetConfig }
  })
  return getDriver(model)._buildConfigurationParams()
}

// Native output events are named after the C++ type, not "Output".
const NATIVE_VAD_EVENT = 'N4qvac7asrggml8parakeet8VadEventE'

class VadEmittingBinding extends MockedBinding {
  appendStreamingAudio(handle, data) {
    const result = super.appendStreamingAudio(handle, data)
    this._callCallbacks(NATIVE_VAD_EVENT, {
      type: 'vad',
      speaking: true,
      score: 0.12,
      timestamp: 0.03,
      source: 'energy'
    })
    return result
  }
}

test('new parakeetConfig keys are accepted and forwarded verbatim', (t) => {
  const params = buildParams({
    streamingEnergyVad: true,
    streamingEnergyVadThresholdDb: -45,
    streamingEnergyVadWindowMs: 40,
    streamingEnergyVadHangoverMs: 300,
    streamingSpeakerVad: true,
    diarizationThreshold: 0.5,
    diarizationMinSegmentMs: 0,
    prewarm: true,
    prewarmAudioSeconds: 2,
    longFormWindowFrames: 750,
    longFormContextFrames: -1
  })

  t.is(params.streamingEnergyVad, true)
  t.is(params.streamingEnergyVadThresholdDb, -45)
  t.is(params.streamingEnergyVadWindowMs, 40)
  t.is(params.streamingEnergyVadHangoverMs, 300)
  t.is(params.streamingSpeakerVad, true)
  t.is(params.diarizationThreshold, 0.5)
  t.is(params.diarizationMinSegmentMs, 0, '0 is forwarded, not treated as unset')
  t.is(params.prewarm, true)
  t.is(params.prewarmAudioSeconds, 2)
  t.is(params.longFormWindowFrames, 750)
  t.is(params.longFormContextFrames, -1)
})

test('unset numeric keys stay undefined so the native config owns the defaults', (t) => {
  const params = buildParams()

  t.is(params.streamingEnergyVadThresholdDb, undefined)
  t.is(params.streamingEnergyVadWindowMs, undefined)
  t.is(params.streamingEnergyVadHangoverMs, undefined)
  t.is(params.diarizationThreshold, undefined)
  t.is(params.diarizationMinSegmentMs, undefined)
  t.is(params.prewarmAudioSeconds, undefined)
  t.is(params.longFormWindowFrames, undefined)
  t.is(params.longFormContextFrames, undefined)
  t.is(params.prewarm, false, 'prewarm is off by default')
  t.is(params.streamingSpeakerVad, false, 'speaker VAD is off by default')
})

test('runStreaming forwards the new per-call overrides to the binding', async (t) => {
  const { model } = createParakeetModel({ binding: new MockedBinding() })
  await model.load()

  const audioStream = pushable()
  const response = await model.runStreaming(audioStream, {
    emitEnergyVad: true,
    energyVadThresholdDb: -50,
    energyVadWindowMs: 20,
    energyVadHangoverMs: 150,
    emitSpeakerVad: true,
    diarizationThreshold: 0.4,
    diarizationMinSegmentMs: 100
  })
  const done = response.onUpdate(() => {}).await()
  audioStream.push(new Float32Array(512))
  audioStream.end()
  await done

  const config = model._mockedBinding._streamingLog.lastConfig
  t.is(config.emitEnergyVad, true)
  t.is(config.energyVadThresholdDb, -50)
  t.is(config.energyVadWindowMs, 20)
  t.is(config.energyVadHangoverMs, 150)
  t.is(config.emitSpeakerVad, true)
  t.is(config.diarizationThreshold, 0.4)
  t.is(config.diarizationMinSegmentMs, 100)

  await model.unload()
})

test('a native VAD payload surfaces as a typed VadEvent next to the segments', async (t) => {
  const { model } = createParakeetModel({
    binding: new VadEmittingBinding(),
    parakeetConfig: { streaming: true, streamingEnergyVad: true }
  })
  await model.load()

  const audioStream = pushable()
  const response = await model.runStreaming(audioStream, { emitEnergyVad: true })
  const updates = []
  const done = response
    .onUpdate((items) => {
      for (const item of Array.isArray(items) ? items : [items]) updates.push(item)
    })
    .await()
  audioStream.push(new Float32Array(1024))
  audioStream.end()
  await done

  const vadEvents = updates.filter((u) => u.type === 'vad')
  t.is(vadEvents.length, 1, 'one VAD event per transition')
  t.alike(vadEvents[0], {
    type: 'vad',
    speaking: true,
    score: 0.12,
    timestamp: 0.03,
    source: 'energy'
  })
  const segments = updates.filter((u) => typeof u.text === 'string')
  t.is(segments.length, 1, 'transcript segments are unaffected')

  await model.unload()
})
