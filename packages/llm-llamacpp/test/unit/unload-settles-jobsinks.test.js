'use strict'

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function createStub(defaultImpl = () => {}) {
  let impl = defaultImpl
  const fn = function (...args) {
    fn.called = true
    fn.callCount += 1
    fn.calls.push(args)
    fn.lastArgs = args
    return impl.apply(this, args)
  }
  fn.called = false
  fn.callCount = 0
  fn.calls = []
  fn.lastArgs = null
  fn.callsFake = (newImpl) => {
    impl = newImpl || (() => {})
    return fn
  }
  return fn
}

/// parallel: 2 puts the model in multi-job mode so run() gets a per-job
/// QvacResponse stored in _jobSinks.
function createMultiJobModel() {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel: 2 },
    opts: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  let nextId = 1
  model.addon = {
    activeJobs: () => 0,
    runJob: createStub(() => ({ accepted: true, id: nextId++ })),
    cancel: createStub(() => Promise.resolve()),
    cancelJob: createStub(() => Promise.resolve()),
    unload: createStub(() => Promise.resolve())
  }
  return model
}

test('unload() settles in-flight concurrent responses instead of hanging', async (t) => {
  const model = createMultiJobModel()

  const response = await model._runInternal([{ role: 'user', content: 'a' }])

  // A caller is awaiting this concurrent response when unload() fires.
  const awaiting = response.await()
  awaiting.catch(() => {})

  await model.unload()

  // The response promise must settle now that the model is gone. Race it
  // against a timer so a hung promise fails the test rather than hanging it.
  const outcome = await Promise.race([
    awaiting.then(
      () => ({ state: 'RESOLVED' }),
      (err) => ({ state: 'REJECTED', err })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ state: 'TIMEOUT' }), 200))
  ])

  t.is(
    outcome.state,
    'REJECTED',
    'awaiting a concurrent response after unload() must reject, not hang forever'
  )
  t.is(
    outcome.err?.message,
    'Model was unloaded',
    'the rejection must report that the model was unloaded'
  )
})
