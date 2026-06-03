'use strict'

// Verifies that a per-call AbortSignal passed to run()/runBatch() is forwarded
// into the QvacResponse, so aborting mid-inference (or passing an already-
// aborted signal) settles the in-flight response with the abort reason.
//
// Lives in the integration suite (not test/unit) because index.js eagerly
// loads the native binding (via ./marian) at require() time, so it can only be
// imported where the prebuild is present. No real model weights are needed:
// the native addon is stubbed at the instance level.

const test = require('brittle')
const TranslationNmtcpp = require('../../index.js')

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

// Inject a fake native addon whose runJob never drives a terminal event, so the
// response stays in-flight until the abort backstop fires. runJob still resolves
// acceptance, matching the native contract the response should be wired around.
// Bypasses load().
function buildModel () {
  const acceptedJobs = []
  const model = new TranslationNmtcpp({
    files: { model: 'model.bin' },
    params: { srcLang: 'en', dstLang: 'fr' },
    config: { modelType: 'Bergamot' }
  })
  model.addon = {
    runJob: async (job) => { acceptedJobs.push(job); return true },
    cancel: async () => {},
    destroy: async () => {}
  }
  model._acceptedJobs = acceptedJobs
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
  const response = await model.run('hello world', { signal })
  const settled = response.await()

  t.is(model._acceptedJobs.length, 1, 'native job was accepted before abort')
  t.absent('signal' in model._acceptedJobs[0], 'signal not forwarded to native runJob')

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')
})

test('run(): an already-aborted signal rejects immediately', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.run('hello world', { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')
})

test('runBatch(): aborting rejects with the abort reason', async (t) => {
  const model = buildModel()

  const { signal, abort } = makeAbortable()
  const settled = model.runBatch(['hello', 'world'], { signal })
  settled.catch(() => {})
  await Promise.resolve()

  t.is(model._acceptedJobs.length, 1, 'native batch job was accepted before abort')

  abort(new Error('batch abort'))
  await expectRejection(t, settled, /batch abort/, 'runBatch()')
})

test('runBatch(): a native runJob failure rejects with the addon error', async (t) => {
  const model = buildModel()
  model.addon.runJob = async () => { throw new Error('native crash') }

  await expectRejection(t, model.runBatch(['hello', 'world']), /native crash/, 'runBatch()')
})

test('run(): a native runJob failure rejects with the addon error', async (t) => {
  const model = buildModel()
  model.addon.runJob = async () => { throw new Error('native crash') }

  await expectRejection(t, model.run('hello world'), /native crash/, 'run()')
})
