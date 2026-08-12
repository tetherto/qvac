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
