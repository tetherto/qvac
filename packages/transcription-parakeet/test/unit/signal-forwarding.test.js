'use strict'

// Verifies that a per-call AbortSignal passed to run()/runStreaming() is
// forwarded into the returned QvacResponse, so aborting mid-transcription (or
// passing an already-aborted signal) settles the in-flight response with the
// abort reason.

const test = require('brittle')
const TranscriptionParakeet = require('../../index.js')

function makeAbortable () {
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener (event, cb, opts) {
      if (event !== 'abort') return
      const wrapped = opts && opts.once ? () => { listeners.delete(wrapped); cb() } : cb
      wrapped._original = cb
      listeners.add(wrapped)
    },
    removeEventListener (event, cb) {
      if (event !== 'abort') return
      for (const l of listeners) if (l === cb || l._original === cb) { listeners.delete(l); return }
    }
  }
  return {
    signal,
    abort (reason) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason
      for (const l of Array.from(listeners)) l()
    }
  }
}

// Bypass load()/native binding: inject a fake addon whose native entrypoints
// accept work but never drive a terminal event, so the response stays in-flight
// until the abort fires.
function buildModel () {
  const model = new TranscriptionParakeet({})
  model.addon = {
    append: async () => true,
    startStreaming: async () => true,
    appendStreamingAudio: async () => {},
    endStreaming: async () => {},
    cancel: async () => {}
  }
  return model
}

async function expectRejection (t, promise, re, message) {
  let err
  try { await promise } catch (e) { err = e }
  t.ok(err, `${message}: rejected`)
  t.ok(err && re.test(err.message), `${message}: reason "${err && err.message}" matches ${re}`)
}

test('run(): aborting mid-transcription rejects with the abort reason', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  const response = await model.run(new Float32Array([0.1, 0.2, 0.3, 0.4]), { signal })
  const settled = response.await()

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')
})

test('run(): an already-aborted signal rejects immediately', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.run(new Float32Array([0.1, 0.2, 0.3, 0.4]), { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')
})

test('runStreaming(): aborting rejects with the abort reason (signal not leaked to native)', async (t) => {
  const model = buildModel()

  let startStreamingConfig
  model.addon.startStreaming = async (cfg) => { startStreamingConfig = cfg }

  const { signal, abort } = makeAbortable()
  const response = await model.runStreaming(pendingStream(), { signal, chunkMs: 2000 })
  const settled = response.await()

  t.absent(startStreamingConfig && 'signal' in startStreamingConfig, 'signal stripped from native streaming config')

  abort(new Error('stream abort'))
  await expectRejection(t, settled, /stream abort/, 'await()')
})

function pendingStream () {
  return {
    async * [Symbol.asyncIterator] () {
      await new Promise(() => {})
    }
  }
}
