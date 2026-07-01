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

/// parallel: 2 puts the model in multi-job mode so each run() gets its own
/// job id and responses are not funnelled through the single-job _job handler.
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
    cancelJob: createStub(() => Promise.resolve())
  }
  return model
}

test('cancel() on one concurrent response cancels only that job, not all', async (t) => {
  const model = createMultiJobModel()

  const first = await model._runInternal([{ role: 'user', content: 'a' }])
  await model._runInternal([{ role: 'user', content: 'b' }])

  await first.cancel()

  t.is(
    model.addon.cancel.called,
    false,
    'whole-model cancel() must NOT be used to cancel a single job'
  )
  t.is(model.addon.cancelJob.callCount, 1, 'per-job cancelJob() must be invoked exactly once')
  t.alike(
    model.addon.cancelJob.lastArgs,
    [1],
    "cancelJob() must target the first response's own job id"
  )
})
