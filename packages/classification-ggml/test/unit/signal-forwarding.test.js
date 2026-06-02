'use strict'

// Verifies that a per-call AbortSignal passed to classify() is forwarded into
// the underlying QvacResponse, so aborting mid-inference (or passing an
// already-aborted signal) rejects the classify() promise with the abort
// reason. No native cancel is invoked — abort only releases the waiter.

const test = require('brittle')
const ImageClassifier = require('../../index.js')

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

// Inject a fake native addon that accepts the job but never emits a terminal
// event, bypassing load() so no model file / native binding is required.
function buildModel () {
  const model = new ImageClassifier()
  model._addon = {
    runJob: async (job) => { model._capturedJob = job; return true },
    cancel: async () => {},
    unload: async () => {}
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

test('classify(): aborting mid-inference rejects with the abort reason', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  const pending = model.classify(new Uint8Array([1, 2, 3, 4]), { signal })

  abort(new Error('aborted by caller'))
  await expectRejection(t, pending, /aborted by caller/, 'classify()')
  t.absent(model._capturedJob && 'signal' in model._capturedJob, 'signal not forwarded to native runJob')
})

test('classify(): an already-aborted signal rejects immediately', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  await expectRejection(t, model.classify(new Uint8Array([1, 2, 3, 4]), { signal }), /pre-aborted/, 'classify()')
})
