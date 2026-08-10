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

/// A multi-job model already at capacity: every admission decision is decided
/// purely by the rejectWhenBusy policy, never by free slots.
function createBusyModel({ rejectWhenBusy } = {}) {
  const parallel = 2
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel },
    opts: rejectWhenBusy === undefined ? {} : { rejectWhenBusy },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  let nextId = 1
  model.addon = {
    activeJobs: () => parallel,
    runJob: createStub((items) => {
      const id = nextId++
      return { accepted: true, id, ids: items.map((item, i) => item.id ?? `batch-${id}-${i}`) }
    }),
    cancel: createStub(() => Promise.resolve()),
    cancelJob: createStub(() => Promise.resolve())
  }
  return model
}

test('per-item rejectWhenBusy: true fails fast at capacity instead of queueing', async (t) => {
  // Instance default at parallel >= 2 is to queue; the item opts out.
  const model = createBusyModel()

  await t.exception(
    () =>
      model.run([
        [{ role: 'user', content: 'a1' }],
        { prompt: [{ role: 'user', content: 'a2' }], runOptions: { rejectWhenBusy: true } }
      ]),
    /already set or being processed/,
    'batch with rejectWhenBusy: true must be refused while the pool is full'
  )
  t.is(model.addon.runJob.called, false, 'a refused batch must never reach the native queue')
})

test('per-item rejectWhenBusy: false queues at capacity despite instance-level true', async (t) => {
  const model = createBusyModel({ rejectWhenBusy: true })

  const response = await model.run([
    { prompt: [{ role: 'user', content: 'b1' }], runOptions: { rejectWhenBusy: false } },
    { prompt: [{ role: 'user', content: 'b2' }], runOptions: { rejectWhenBusy: false } }
  ])

  t.is(model.addon.runJob.callCount, 1, 'the batch must be handed to the native queue')
  t.is(response.ids.length, 2, 'admission must return one id per prompt')
})

test('conflicting per-item rejectWhenBusy values are rejected', async (t) => {
  const model = createBusyModel()

  // exception.all: TypeError is opted out of plain t.exception by brittle.
  await t.exception.all(
    () =>
      model.run([
        { prompt: [{ role: 'user', content: 'c1' }], runOptions: { rejectWhenBusy: true } },
        { prompt: [{ role: 'user', content: 'c2' }], runOptions: { rejectWhenBusy: false } }
      ]),
    /rejectWhenBusy/,
    'a batch is admitted as one job; items must agree on the admission policy'
  )
  t.is(model.addon.runJob.called, false, 'a conflicting batch must never reach the native queue')
})
