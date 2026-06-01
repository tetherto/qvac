'use strict'

// Verifies that a per-call AbortSignal passed to run()/runStreaming() is
// forwarded into the returned QvacResponse, so aborting mid-transcription (or
// passing an already-aborted signal) settles the in-flight response with the
// abort reason.

const test = require('brittle')
const TranscriptionWhispercpp = require('../../index.js')

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

// Bypass load()/native binding: the constructor's validateModelFiles() needs a
// real path, so point it at this test file. Inject a fake addon whose append()
// never drives a terminal event so the response stays in-flight.
function buildModel () {
  const model = new TranscriptionWhispercpp(
    { files: { model: 'model.bin' } },
    { whisperConfig: {}, path: __filename }
  )
  model.addon = {
    append: async () => 'job-1',
    cancel: async () => {},
    _activeJobId: 'job-1'
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
  const response = await model.run(new Uint8Array([1, 2, 3, 4]), { signal })
  const settled = response.await()

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')
})

test('run(): an already-aborted signal rejects immediately', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.run(new Uint8Array([1, 2, 3, 4]), { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')
})
