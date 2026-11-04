'use strict'

const test = require('brittle')
const { collectAudioGenResponse } = require('../utils/runAudioGen')

test('audio collection consumes the terminal result when the stream fails', async (t) => {
  const failure = new Error('native allocation failed')
  let terminalRead = false
  const response = {
    async *iterate() {
      throw failure
    },
    await() {
      terminalRead = true
      return Promise.reject(failure)
    }
  }

  await t.exception(() => collectAudioGenResponse(response), failure)
  t.ok(terminalRead, 'the native terminal rejection has a consumer')
})

test('audio collection propagates terminal failures after the stream ends', async (t) => {
  const failure = new Error('native allocation failed')
  const response = {
    async *iterate() {},
    await() {
      return Promise.reject(failure)
    }
  }

  await t.exception(() => collectAudioGenResponse(response), failure)
})

test('audio collection preserves PCM, progress and terminal statistics', async (t) => {
  const pcm = new Int16Array([0, 16384, -16384, 0])
  const stats = { totalTimeMs: 1 }
  const response = {
    async *iterate() {
      yield { progress: { stage: 'dit', total: 8 } }
      yield { outputArray: pcm, sampleRate: 48000, channels: 2 }
    },
    await() {
      return Promise.resolve(stats)
    }
  }

  const { data } = await collectAudioGenResponse(response)

  t.is(data.sampleCount, pcm.length)
  t.is(data.sampleRate, 48000)
  t.is(data.channels, 2)
  t.is(data.durationMs, (pcm.length / 2 / 48000) * 1000)
  t.is(data.chunkCount, 1)
  t.alike(data.stages, ['dit'])
  t.alike(data.stageTotals, { dit: 8 })
  t.is(data.peak, 0.5)
  t.is(data.rms, Math.sqrt(0.125))
  t.alike(data.chunks, [pcm])
  t.is(data.stats, stats)
})
