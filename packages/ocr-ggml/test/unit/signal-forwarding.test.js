'use strict'

// Verifies that a per-call AbortSignal passed to run() is forwarded into the
// returned QvacResponse, so aborting mid-inference (or passing an already-
// aborted signal) settles the in-flight response with the abort reason.

const test = require('brittle')
const { OcrGgml } = require('../../index.js')

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

// Bypass load()/native binding: inject a fake addon and stub image decoding so
// run() reaches `_job.start({ signal })` without touching the filesystem.
function buildModel () {
  const model = new OcrGgml({
    params: { pathDetector: 'd.gguf', pathRecognizer: 'r.gguf', langList: ['en'] }
  })
  model.addon = {
    runJob: async (job) => { model._capturedJob = job; return true },
    cancel: async () => {},
    destroy: async () => {}
  }
  model._readImage = () => ({ data: Buffer.from([0, 0, 0, 0]), isEncoded: true })
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
