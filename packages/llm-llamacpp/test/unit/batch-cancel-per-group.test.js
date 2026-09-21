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

/// parallel: 4 puts the model in multi-job mode; each run() — batch or
/// single — is admitted as its own tagged native job.
function createMultiJobModel() {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel: 4 },
    opts: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  let nextId = 1
  model.addon = {
    activeJobs: () => 0,
    runJob: createStub((items) => {
      const id = nextId++
      if (Array.isArray(items)) {
        return { accepted: true, id, ids: items.map((item, i) => item.id ?? `batch-${id}-${i}`) }
      }
      return { accepted: true, id }
    }),
    cancel: createStub(() => Promise.resolve()),
    cancelJob: createStub(() => Promise.resolve())
  }
  return model
}

test('cancel() on one batch response cancels only that group, not all jobs', async (t) => {
  const model = createMultiJobModel()

  const batchA = await model.run([
    [{ role: 'user', content: 'a1' }],
    [{ role: 'user', content: 'a2' }]
  ])
  await model.run([[{ role: 'user', content: 'b1' }], [{ role: 'user', content: 'b2' }]])
  await model.run([{ role: 'user', content: 'single' }])

  await batchA.cancel()

  t.is(
    model.addon.cancel.called,
    false,
    'whole-model cancel() must NOT be used to cancel a batch group; it kills the peer batch and the single request'
  )
  t.is(model.addon.cancelJob.callCount, 1, 'per-job cancelJob() must be invoked exactly once')
  t.alike(
    model.addon.cancelJob.lastArgs,
    [1],
    "cancelJob() must target the first batch group's own native job id"
  )
})
