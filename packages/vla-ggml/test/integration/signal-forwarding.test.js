'use strict'

// Verifies that a per-call AbortSignal passed to run() is forwarded into the
// returned QvacResponse, so aborting mid-inference (or passing an already-
// aborted signal) settles the in-flight response with the abort reason.
//
// Lives in the integration suite (not test/unit) because index.js eagerly
// loads the native binding at require() time, so it can only be imported where
// the prebuild is present. No real model weights are needed: the module-level
// `binding.runJob` is monkeypatched (and restored) so _runInternal reaches
// `_job.start({ signal })` and accepts the job without touching native state.

const test = require('brittle')
const { VlaModel } = require('../../index.js')
const binding = require('../../binding')

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

// Build a model whose native handle and hparams are faked, with binding.runJob
// stubbed to accept the job without emitting a terminal event.
function buildModel () {
  const model = new VlaModel({ files: { model: ['/tmp/model.gguf'] } })
  model._handle = {}
  model._hparams = {}
  model.cancel = async () => {}
  return model
}

function validInput () {
  return {
    images: [new Float32Array(4)],
    state: new Float32Array(4),
    tokens: new Int32Array(1),
    mask: new Int32Array(1)
  }
}

async function expectRejection (t, promise, re, message) {
  let err
  try { await promise } catch (e) { err = e }
  t.ok(err, `${message}: rejected`)
  t.ok(err && re.test(err.message), `${message}: reason "${err && err.message}" matches ${re}`)
}

test('run(): aborting mid-inference rejects with the abort reason', async (t) => {
  const original = binding.runJob
  binding.runJob = () => true
  t.teardown(() => { binding.runJob = original })

  const model = buildModel()

  const { signal, abort } = makeAbortable()
  const response = await model.run(validInput(), { signal })
  const settled = response.await()

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')
})

test('run(): an already-aborted signal rejects immediately', async (t) => {
  const original = binding.runJob
  binding.runJob = () => true
  t.teardown(() => { binding.runJob = original })

  const model = buildModel()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.run(validInput(), { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')
})
