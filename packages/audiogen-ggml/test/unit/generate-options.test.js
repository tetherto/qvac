'use strict'

const test = require('brittle')
const { AudioGen } = require('../../index.js')

function createHarness() {
  let received
  const gen = new AudioGen()
  gen.addon = {
    runJob(data) {
      received = data
      gen._addonOutputCallback(null, null, { totalTimeMs: 0 }, null)
      return Promise.resolve()
    },
    cancel: () => Promise.resolve(),
    destroyInstance: () => Promise.resolve()
  }
  return { gen, received: () => received }
}

test('AudioGen.run forwards sampler, DCW and frozen-code controls', async (t) => {
  const { gen, received } = createHarness()
  const audioCodes = new Int32Array([12095, 63487, 12741])

  const response = await gen.run('upbeat pop rock', {
    duration: 8,
    lmTemperature: 0.7,
    lmTopP: 0.8,
    lmTopK: 0,
    lmCfgScale: 1.5,
    lmPhase1: false,
    dcwEnabled: false,
    dcwScaler: 0,
    dcwHighScaler: 0,
    audioCodes
  })
  await response.await()

  const job = received()
  t.is(job.input, 'upbeat pop rock')
  t.is(job.duration, 8)
  t.is(job.lmTemperature, 0.7)
  t.is(job.lmTopP, 0.8)
  t.is(job.lmTopK, 0, 'zero top-k is preserved')
  t.is(job.lmCfgScale, 1.5)
  t.is(job.lmPhase1, false, 'false Phase 1 flag is preserved')
  t.is(job.dcwEnabled, false, 'false DCW flag is preserved')
  t.is(job.dcwScaler, 0, 'zero low-frequency scaler is preserved')
  t.is(job.dcwHighScaler, 0, 'zero high-frequency scaler is preserved')
  t.is(job.audioCodes, audioCodes, 'the Int32Array reaches the native job unchanged')
})

test('AudioGen.run rejects invalid sampler and DCW controls before native dispatch', async (t) => {
  const numericControls = ['lmTemperature', 'lmTopP', 'lmCfgScale', 'dcwScaler', 'dcwHighScaler']

  for (const name of numericControls) {
    const { gen } = createHarness()
    await t.exception(
      () => gen.run('test', { [name]: Number.POSITIVE_INFINITY }),
      new RegExp(`${name} must be a finite number`)
    )
  }

  {
    const { gen } = createHarness()
    await t.exception(() => gen.run('test', { lmTopK: 1.5 }), /lmTopK must be an integer/)
  }
  {
    const { gen } = createHarness()
    await t.exception(() => gen.run('test', { lmPhase1: 1 }), /lmPhase1 must be a boolean/)
  }
  {
    const { gen } = createHarness()
    await t.exception(() => gen.run('test', { dcwEnabled: 'yes' }), /dcwEnabled must be a boolean/)
  }
  {
    const { gen } = createHarness()
    await t.exception(
      () => gen.run('test', { audioCodes: new Uint32Array([1, 2, 3]) }),
      /audioCodes must be an Int32Array/
    )
  }
})

test('AudioGen.run forwards reference/source audio, taskType and cover strengths', async (t) => {
  const { gen, received } = createHarness()
  const referenceAudio = new Float32Array([0.1, -0.1, 0.2, -0.2])
  const sourceAudio = new Float32Array([0.3, -0.3, 0.4, -0.4, 0.5, -0.5])

  const response = await gen.run('salsa cover', {
    taskType: 'cover-nofsq',
    referenceAudio,
    sourceAudio,
    audioCoverStrength: 1,
    coverNoiseStrength: 0.25
  })
  await response.await()

  const job = received()
  t.is(job.taskType, 'cover-nofsq')
  t.is(job.referenceAudio, referenceAudio)
  t.is(job.sourceAudio, sourceAudio)
  t.is(job.audioCoverStrength, 1)
  t.is(job.coverNoiseStrength, 0.25)
})

test('AudioGen.run forwards text2music with optional referenceAudio only', async (t) => {
  const { gen, received } = createHarness()
  const referenceAudio = new Float32Array([0, 0, 0.5, -0.5])

  const response = await gen.run('timbre conditioned', {
    taskType: 'text2music',
    referenceAudio
  })
  await response.await()

  const job = received()
  t.is(job.taskType, 'text2music')
  t.is(job.referenceAudio, referenceAudio)
  t.is(job.sourceAudio, undefined)
})

async function rejectRunOptions(t, options, pattern) {
  const { gen } = createHarness()
  await t.exception(() => gen.run('test', options), pattern)
}

test('AudioGen.run rejects unsupported taskType', async (t) => {
  await rejectRunOptions(
    t,
    { taskType: 'repaint' },
    /taskType must be one of text2music\|cover\|cover-nofsq/
  )
})

test('AudioGen.run requires sourceAudio for cover-nofsq', async (t) => {
  await rejectRunOptions(
    t,
    { taskType: 'cover-nofsq' },
    /taskType 'cover-nofsq' requires sourceAudio/
  )
})

test('AudioGen.run rejects empty sourceAudio for cover', async (t) => {
  await rejectRunOptions(
    t,
    { taskType: 'cover', sourceAudio: new Float32Array(0) },
    /taskType 'cover' requires sourceAudio/
  )
})

test('AudioGen.run requires Float32Array referenceAudio', async (t) => {
  await rejectRunOptions(
    t,
    { referenceAudio: new Int16Array([1, 2]) },
    /referenceAudio must be a Float32Array/
  )
})

test('AudioGen.run requires stereo sourceAudio', async (t) => {
  await rejectRunOptions(
    t,
    { sourceAudio: new Float32Array([1, 2, 3]) },
    /sourceAudio must be interleaved stereo/
  )
})

test('AudioGen.run requires stereo referenceAudio', async (t) => {
  await rejectRunOptions(
    t,
    { referenceAudio: new Float32Array([1, 2, 3]) },
    /referenceAudio must be interleaved stereo/
  )
})

test('AudioGen.run rejects non-finite referenceAudio samples', async (t) => {
  await rejectRunOptions(
    t,
    { referenceAudio: new Float32Array([0, Number.NaN]) },
    /referenceAudio must contain only finite samples/
  )
})

test('AudioGen.run rejects non-finite sourceAudio samples', async (t) => {
  await rejectRunOptions(
    t,
    { sourceAudio: new Float32Array([Number.POSITIVE_INFINITY, 0]) },
    /sourceAudio must contain only finite samples/
  )
})

test('AudioGen.run requires finite audioCoverStrength', async (t) => {
  await rejectRunOptions(
    t,
    { audioCoverStrength: Number.NaN },
    /audioCoverStrength must be a finite number/
  )
})

test('AudioGen.run requires finite coverNoiseStrength', async (t) => {
  await rejectRunOptions(
    t,
    { coverNoiseStrength: Number.POSITIVE_INFINITY },
    /coverNoiseStrength must be a finite number/
  )
})
