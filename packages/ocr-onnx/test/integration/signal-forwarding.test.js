'use strict'

// Verifies that a per-call AbortSignal passed to run() is forwarded into the
// returned QvacResponse, so aborting mid-inference (or passing an already-
// aborted signal) settles the in-flight response with the abort reason.
//
// Lives in the integration suite (not test/unit) because index.js eagerly
// loads the native binding at require() time, so it can only be imported where
// the prebuild is present. No real model weights are needed: the native addon
// and image decoding are stubbed at the instance level.

const test = require('brittle')
const { ONNXOcr } = require('../../index.js')

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

// Inject a fake native addon whose runJob accepts the job but never drives a
// terminal event, and stub image decoding so run() reaches `_job.start({ signal })`
// without weights.
function buildModel () {
  const model = new ONNXOcr({
    params: { pathDetector: 'd.onnx', pathRecognizer: 'r.onnx', langList: ['en'] }
  })
  model.addon = {
    runJob: async (job) => { model._capturedJob = job; return true },
    cancel: async () => {},
    destroy: async () => {}
  }
  model.getImage = () => ({ data: Buffer.from([0, 0, 0, 0]), isEncoded: true })
  return model
}

async function expectRejection (t, promise, re, message) {
  let err
  try { await promise } catch (e) { err = e }
  t.ok(err, `${message}: rejected`)
  t.ok(err && re.test(err.message), `${message}: reason "${err && err.message}" matches ${re}`)
}

test('run(): aborting mid-inference rejects with the abort reason', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  const response = await model.run({ path: 'image.png' }, { signal })
  const settled = response.await()

  t.absent(model._capturedJob && 'signal' in model._capturedJob, 'signal not forwarded to native runJob')

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')
})

test('run(): an already-aborted signal rejects immediately', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.run({ path: 'image.png' }, { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')
})
