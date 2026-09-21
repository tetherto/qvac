'use strict'

// The single top-level `enableStats` option (default TRUE) gates whether the
// drivers attach the native JobEnded stats payload via ctx.job.end(stats):
//   - whisper: replaces the old opt-in `opts.stats` (default flips to on),
//   - parakeet: fixes the historically dead `config.enableStats` (stats were
//     always attached; `false` now actually works).
//
// QvacResponse initialises `stats` to `{}`, so "suppressed" means the response
// still carries that empty default -- job.end() was called without a payload.

const test = require('brittle')
const { createWhisperModel, createParakeetModel, pushable } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

test('whisper: stats attach to the response by default', async (t) => {
  const { model } = createWhisperModel()
  t.is(model.enableStats, true, 'enableStats defaults to true')
  await model.load()

  const response = await model.run(new Uint8Array([1, 2, 3, 4]))
  await response.await()

  t.ok(response.stats, 'response carries the JobEnded stats payload')
  t.is(typeof response.stats.totalTime, 'number', 'stats payload has the whisper shape')

  await model.destroy()
})

test('whisper: enableStats false suppresses the stats payload', async (t) => {
  const { model } = createWhisperModel({ options: { enableStats: false } })
  t.is(model.enableStats, false, 'enableStats option is exposed')
  await model.load()

  const response = await model.run(new Uint8Array([1, 2, 3, 4]))
  await response.await()

  t.alike(response.stats, {}, 'job.end() is called without the stats payload')

  await model.destroy()
})

test('parakeet: stats attach to the response by default', async (t) => {
  const { model } = createParakeetModel()
  t.is(model.enableStats, true, 'enableStats defaults to true')
  await model.load()

  const response = await model.run(new Float32Array(1600))
  await response.await()

  t.ok(response.stats, 'response carries the runtime-stats payload')
  t.is(typeof response.stats.totalSamples, 'number', 'stats payload has the parakeet shape')

  await model.destroy()
})

test('parakeet: enableStats false suppresses the stats payload', async (t) => {
  const { model } = createParakeetModel({ options: { enableStats: false } })
  await model.load()

  const response = await model.run(new Float32Array(1600))
  await response.await()

  t.alike(response.stats, {}, 'enableStats:false now actually works (was dead code)')

  await model.destroy()
})

test('enableStats gates streaming JobEnded stats too', async (t) => {
  const { model } = createParakeetModel({ options: { enableStats: false } })
  await model.load()

  const stream = pushable()
  const response = await model.runStreaming(stream)
  const done = response.onUpdate(() => {}).await()
  stream.push(new Float32Array(1024))
  stream.end()
  await done

  t.alike(response.stats, {}, 'synthetic streaming JobEnded stats are suppressed as well')

  await model.destroy()
})
