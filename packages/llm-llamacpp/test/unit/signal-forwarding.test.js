'use strict'

// Verifies that a per-call AbortSignal passed to run()/finetune() is forwarded
// into the returned QvacResponse, so aborting mid-inference (or passing an
// already-aborted signal) settles the in-flight response with the abort
// reason. No native cancel is invoked — abort only releases the waiter.

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

// Duck-typed AbortController: infer-base only touches `aborted` / `reason` /
// `addEventListener` / `removeEventListener`, and Bare has no global one.
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

// Fake native addon: accepts runJob/finetune but never emits a terminal event,
// so the response stays in-flight until the abort backstop fires.
function buildModel () {
  const model = new LlmLlamacpp({ files: { model: ['/tmp/fake-llm-model.gguf'] }, config: {} })
  model._createAddon = () => ({
    activate: async () => {},
    runJob: async () => true,
    finetune: async () => true,
    cancel: async () => {},
    unload: async () => {}
  })
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
  await model.load()

  const { signal, abort } = makeAbortable()
  const response = await model.run([{ role: 'user', content: 'hi' }], { signal })
  const settled = response.await()

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')

  await model.unload()
})

test('run(): an already-aborted signal rejects immediately', async (t) => {
  const model = buildModel()
  await model.load()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.run([{ role: 'user', content: 'hi' }], { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')

  await model.unload()
})

test('run(): iterate() also rejects on abort', async (t) => {
  const model = buildModel()
  await model.load()

  const { signal, abort } = makeAbortable()
  const response = await model.run([{ role: 'user', content: 'hi' }], { signal })

  const drained = (async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of response.iterate()) { /* no output before abort */ }
  })()

  abort(new Error('iterate abort'))
  await expectRejection(t, drained, /iterate abort/, 'iterate()')

  await model.unload()
})

test('finetune(): aborting rejects with the abort reason (signal not leaked to native params)', async (t) => {
  const model = buildModel()
  let finetuneParams = null
  model._createAddon = () => ({
    activate: async () => {},
    runJob: async () => true,
    finetune: async (params) => { finetuneParams = params; return true },
    cancel: async () => {},
    unload: async () => {}
  })
  await model.load()

  const { signal, abort } = makeAbortable()
  const response = await model.finetune({ validation: { type: 'none' }, signal })
  const settled = response.await()

  t.absent(finetuneParams && 'signal' in finetuneParams, 'signal is stripped from native finetune params')

  abort(new Error('finetune abort'))
  await expectRejection(t, settled, /finetune abort/, 'await()')

  await model.unload()
})
