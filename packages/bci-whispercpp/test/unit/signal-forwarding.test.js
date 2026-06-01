'use strict'

// Verifies that a per-call AbortSignal passed to transcribe()/transcribeStream()
// is forwarded into the returned QvacResponse, so aborting mid-inference (or
// passing an already-aborted signal) settles the in-flight response with the
// abort reason.

const test = require('brittle')
const BCIWhispercpp = require('../../index.js')

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

// Bypass load()/native binding: inject a fake addon whose runJob accepts the
// job (returns true) but never drives a terminal event, so the response stays
// in-flight until the abort backstop fires.
function buildModel () {
  const model = new BCIWhispercpp({ files: { model: 'model.bin' } }, {})
  model.addon = {
    runJob: async () => true,
    cancel: async () => {},
    destroyInstance: async () => {}
  }
  model.state.configLoaded = true
  return model
}

async function expectRejection (t, promise, re, message) {
  let err
  try { await promise } catch (e) { err = e }
  t.ok(err, `${message}: rejected`)
  t.ok(err && re.test(err.message), `${message}: reason "${err && err.message}" matches ${re}`)
}

test('transcribe(): aborting mid-inference rejects with the abort reason', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  const response = await model.transcribe(new Uint8Array([1, 2, 3, 4]), { signal })
  const settled = response.await()

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')
})

test('transcribe(): an already-aborted signal rejects immediately', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.transcribe(new Uint8Array([1, 2, 3, 4]), { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')
})
