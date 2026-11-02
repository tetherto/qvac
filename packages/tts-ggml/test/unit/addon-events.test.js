'use strict'

const test = require('brittle')
const process = require('bare-process')
const { AddonEventRouter } = require('../../lib/addonEvents.js')

global.process = process

function fakeHost({ reportStats = false, consumesStats = false } = {}) {
  const host = {
    outputs: [],
    ends: [],
    fails: [],
    logs: [],
    rejected: [],
    statsSeen: [],
    job: {
      output: (data) => host.outputs.push(data),
      end: (...args) => host.ends.push(args),
      fail: (error) => host.fails.push(error)
    },
    stream: {
      ctx: null,
      enrich: (data) => ({ ...data, chunkIndex: 7 }),
      onStats: (data) => {
        host.statsSeen.push(data)
        return consumesStats
      },
      rejectActiveChunk: (error) => host.rejected.push(error)
    },
    logger: () => ({
      debug: (...args) => host.logs.push(['debug', ...args]),
      info: (...args) => host.logs.push(['info', ...args]),
      error: (...args) => host.logs.push(['error', ...args])
    }),
    reportStats: () => reportStats
  }
  return host
}

test('addon events: an error string fails the job and the chunk in flight', (t) => {
  const host = fakeHost()
  const router = new AddonEventRouter(host)
  router.route('Error', null, 'Job cancelled')
  t.alike(host.fails, ['Job cancelled'])
  t.is(host.rejected.length, 1)
  t.ok(host.rejected[0] instanceof Error)
  t.is(host.rejected[0].message, 'Job cancelled')
  t.alike(host.logs, [['error', 'TTS job failed with error: Job cancelled']])
  router.route('AudioResult', { outputArray: new Int16Array(1) }, '')
  t.is(host.outputs.length, 1, 'an empty error string is no error; the data routes as usual')
  t.is(host.fails.length, 1)
})

test('addon events: audio is enriched only while a sentence stream is active', (t) => {
  const host = fakeHost()
  const router = new AddonEventRouter(host)
  const chunk = { outputArray: new Int16Array(2), sampleRate: 24000 }
  router.route('AudioResult', chunk, null)
  t.is(host.outputs[0], chunk, 'a plain run forwards the native chunk as it is')
  host.stream.ctx = {}
  router.route('AudioResult', chunk, null)
  t.is(host.outputs[1].chunkIndex, 7)
  t.is(host.outputs[1].sampleRate, 24000)
  t.alike(host.ends, [])
})

test('addon events: stats end the job unless the stream consumes them', (t) => {
  const quiet = fakeHost()
  new AddonEventRouter(quiet).route('RuntimeStats', { totalTime: 0.5 }, null)
  t.alike(quiet.ends, [[]], 'without opts.stats the job ends without stats')
  t.alike(quiet.statsSeen, [{ totalTime: 0.5 }], 'the stream sees every stats event')
  t.alike(quiet.logs, [['info', 'TTS job completed. Stats: {"totalTime":0.5}']])

  const reported = fakeHost({ reportStats: true })
  new AddonEventRouter(reported).route('RuntimeStats', { totalTime: 0.5 }, null)
  t.alike(reported.ends, [[{ totalTime: 0.5 }]], 'with opts.stats they reach the response')

  const streaming = fakeHost({ reportStats: true, consumesStats: true })
  const router = new AddonEventRouter(streaming)
  router.route('RuntimeStats', { totalTime: 0.5 }, null)
  t.alike(streaming.ends, [], 'an active stream owns the end of the job')
  router.endJob({ totalTime: 1, tokensPerSecond: 8 })
  t.alike(
    streaming.ends,
    [[{ totalTime: 1, tokensPerSecond: 8 }]],
    'and ends it with the aggregate'
  )
})

test('addon events: anything else is only logged', (t) => {
  const host = fakeHost()
  new AddonEventRouter(host).route('Progress', { percent: 50 }, null)
  t.alike(host.outputs, [])
  t.alike(host.ends, [])
  t.alike(host.fails, [])
  t.alike(host.logs, [['debug', 'Received TTS event: Progress']])
})

test('addon events: an oversized debug render does not lose the audio', (t) => {
  const host = fakeHost()
  let calls = 0
  host.logger = () => ({
    debug: (message) => {
      if (++calls === 1) throw new RangeError('Invalid string length')
      host.logs.push(message)
    },
    info: () => {},
    error: () => {}
  })
  const router = new AddonEventRouter(host)
  const chunk = { outputArray: new Int16Array(1) }
  router.route('AudioResult', chunk, null)
  t.alike(host.logs, ['TTS job produced output: [data too large]'])
  t.is(host.outputs[0], chunk)

  host.logger = () => ({
    debug: () => {
      throw new Error('broken logger')
    },
    info: () => {},
    error: () => {}
  })
  t.exception(
    () => router.route('AudioResult', chunk, null),
    /broken logger/,
    'other errors propagate'
  )
})
