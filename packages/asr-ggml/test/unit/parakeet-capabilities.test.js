'use strict'

const test = require('brittle')
const process = require('bare-process')
const ASRGgml = require('../../index.js')
const MockedBinding = require('../mocks/ParakeetMockedBinding.js')
const {
  MODEL_PATH,
  createParakeetModel,
  getDriver,
  getJob,
  pushable
} = require('../mocks/createModel.js')

global.process = process

function buildParams(parakeetConfig = {}) {
  const model = new ASRGgml({
    files: { model: MODEL_PATH },
    config: { engine: 'parakeet', parakeetConfig }
  })
  return getDriver(model)._buildConfigurationParams()
}

const ATTRIBUTED_SEGMENTS = [
  { text: 'How are you?', speakerId: 0, start: 0.2, end: 1.5, toAppend: true, isFinal: true },
  { text: 'Doing well, thanks.', speakerId: 1, start: 1.8, end: 3.5, toAppend: true, isFinal: true }
]

class AttributedBinding extends MockedBinding {
  _callCallbacks(event, output, error) {
    super._callCallbacks(event, event === 'Output' ? ATTRIBUTED_SEGMENTS : output, error)
  }
}

const STREAM_SEGMENT = {
  text: 'Hello.',
  start: 0,
  end: 0.06,
  toAppend: true,
  tokenIds: [1, 7, 9],
  isFinal: false,
  chunkIndex: 0,
  isEndOfTurn: true,
  eotConfidence: 0.875,
  startsWord: true
}
const FINAL_SEGMENT = { text: '', tokenIds: [], isFinal: true, chunkIndex: 1, eotConfidence: 0 }
const END_OF_TURN = {
  type: 'endOfTurn',
  source: 'model-eou',
  timestamp: 0.06123456789,
  chunkIndex: 0,
  confidence: 0.875
}
const VAD = {
  type: 'vad',
  source: 'energy',
  speaking: false,
  score: 0,
  timestamp: 0.06,
  chunkIndex: 0
}

class MetadataBinding extends MockedBinding {
  _callCallbacks(event, output, error) {
    super._callCallbacks(event, event === 'Output' ? [STREAM_SEGMENT] : output, error)
  }

  appendStreamingAudio(handle, data) {
    const result = super.appendStreamingAudio(handle, data)
    process.nextTick(() => {
      super._callCallbacks('NativeEndOfTurnEvent', END_OF_TURN, null)
      super._callCallbacks('NativeVadEvent', VAD, null)
    })
    return result
  }

  endStreaming(handle) {
    process.nextTick(() => super._callCallbacks('Output', [FINAL_SEGMENT], null))
    process.nextTick(() => super._callCallbacks('Output', [], null))
    return super.endStreaming(handle)
  }
}

test('Parakeet selectors reach the native boundary without a whitelist or GPU coercion', (t) => {
  for (const backend of [
    '',
    'auto',
    'cpu',
    'metal',
    'cuda',
    'vulkan',
    'opencl',
    'webgpu',
    'hexagon',
    'CUDA1',
    'MTL0',
    'HTP0',
    'future-device'
  ]) {
    for (const useGPU of [false, true]) {
      const params = buildParams({ backend, useGPU })
      t.is(params.backend, backend)
      t.is(params.useGPU, useGPU)
    }
  }
  t.is(buildParams().backend, undefined)
  for (const backend of [null, 1, true, {}, []]) {
    t.exception(() => buildParams({ backend }), /backend must be a string/)
  }
})

test('backend reload validates before touching the live native instance', async (t) => {
  const { model, binding } = createParakeetModel({ parakeetConfig: { backend: 'cpu' } })
  await model.load()
  await model.reload({ parakeetConfig: { backend: 'CUDA1' } })
  t.is(binding._config.backend, 'CUDA1')
  const handle = binding._handle
  await t.exception(model.reload({ parakeetConfig: { backend: 42 } }), /backend must be a string/)
  t.is(binding._handle, handle)
  t.is(getDriver(model).params.backend, 'CUDA1')
  await model.unload()
})

test('speaker attribution preserves native defaults and explicit false and zero', (t) => {
  t.is(buildParams().speakerAttribution, undefined)
  const nativeDefaults = { modelPath: '/models/diarizer.gguf' }
  t.alike(buildParams({ speakerAttribution: nativeDefaults }).speakerAttribution, nativeDefaults)
  const explicit = { ...nativeDefaults, mergeSameSpeaker: false, minSegmentMs: 0, padSegmentMs: 0 }
  t.alike(buildParams({ speakerAttribution: explicit }).speakerAttribution, explicit)
  t.exception(
    () => buildParams({ speakerAttribution: { ...nativeDefaults, padSegmentMs: -1 } }),
    /non-negative/
  )
})

test('invalid attribution config fails before native loading', (t) => {
  for (const speakerAttribution of [
    null,
    true,
    [],
    {},
    { modelPath: '' },
    { modelPath: '   ' },
    { modelPath: 1 },
    { modelPath: MODEL_PATH, mergeSameSpeaker: 0 },
    { modelPath: MODEL_PATH, minSegmentMs: 1.5 },
    { modelPath: MODEL_PATH, padSegmentMs: NaN },
    { modelPath: MODEL_PATH, minSegmentMs: -1 },
    { modelPath: MODEL_PATH, minSegmentMs: 2147483648 },
    { modelPath: MODEL_PATH, padSegmentMs: -2147483649 },
    { modelPath: MODEL_PATH, unexpected: true }
  ]) {
    t.exception(() => buildParams({ speakerAttribution }))
  }
  t.exception(
    () => buildParams({ speakerAttribution: { modelPath: MODEL_PATH }, streaming: true }),
    /batch run/
  )
})

test('attributed batch output retains text, speakers and segment times across repeated calls', async (t) => {
  const { model, binding } = createParakeetModel({
    binding: new AttributedBinding(),
    parakeetConfig: { speakerAttribution: { modelPath: MODEL_PATH } }
  })
  await model.load()
  const handle = binding._handle
  for (let turn = 0; turn < 2; turn++) {
    const seen = []
    const response = await model.run(new Float32Array(64000))
    await response.onUpdate((segments) => seen.push(...segments)).await()
    t.alike(seen, ATTRIBUTED_SEGMENTS)
    t.is(binding._handle, handle, 'the loaded native instance is reused')
  }
  const stream = pushable()
  stream.end()
  await t.exception(model.runStreaming(stream), /batch run/)
  t.absent(getJob(model).active, 'unsupported streaming did not leave an active response')
  await model.unload()
})

test('attribution reload forwards replacements and can return to standalone ASR', async (t) => {
  const { model, binding } = createParakeetModel()
  await model.load()
  const speakerAttribution = { modelPath: MODEL_PATH, mergeSameSpeaker: false, padSegmentMs: 100 }
  await model.reload({ parakeetConfig: { speakerAttribution } })
  t.alike(binding._config.speakerAttribution, speakerAttribution)
  const handle = binding._handle
  await t.exception(model.reload({ parakeetConfig: { speakerAttribution: {} } }), /modelPath/)
  t.is(binding._handle, handle)
  await model.reload({ parakeetConfig: { speakerAttribution: undefined } })
  t.is(binding._config.speakerAttribution, undefined)
  await model.unload()
})

test('native streaming metadata, empty final markers and precise event timing survive response drainage', async (t) => {
  const { model } = createParakeetModel({ binding: new MetadataBinding() })
  await model.load()
  const stream = pushable()
  const response = await model.runStreaming(stream)
  const updates = []
  const done = response
    .onUpdate((items) => updates.push(...(Array.isArray(items) ? items : [items])))
    .await()
  stream.push(new Float32Array(1024))
  stream.end()
  await done
  t.alike(
    updates,
    [STREAM_SEGMENT, END_OF_TURN, VAD, FINAL_SEGMENT],
    'the complete mixed output sequence preserves text, boundary and final-marker ordering without duplicates'
  )
  await model.unload()
})

test('legacy segment-only end-of-turn events remain supported', async (t) => {
  const { model } = createParakeetModel()
  await model.load()
  const driver = getDriver(model)
  const response = getJob(model).start()
  const seen = []
  const done = response.onUpdate((items) => seen.push(items)).await()
  driver._outputCallback(null, 'Output', 0, [{ text: 'Bye.', isEndOfTurn: true }])
  driver._outputCallback(null, 'JobEnded', 0, {})
  await done
  t.alike(seen, [[{ text: 'Bye.', isEndOfTurn: true }], { type: 'endOfTurn', source: 'model-eou' }])
  await model.unload()
})
