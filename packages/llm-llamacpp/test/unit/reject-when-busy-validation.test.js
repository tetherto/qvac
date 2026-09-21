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

const PARALLEL = 2

/// Multi-job model with a stubbed addon. `activeJobs` selects idle (0) or
/// at-capacity (PARALLEL) so admission is decided purely by rejectWhenBusy.
function createModel({ activeJobs = 0, opts = {} } = {}) {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel: PARALLEL },
    opts,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  let nextId = 1
  model.addon = {
    activeJobs: () => activeJobs,
    runJob: createStub((items) => {
      const id = nextId++
      return { accepted: true, id, ids: items.map((item, i) => item.id ?? `batch-${id}-${i}`) }
    }),
    cancel: createStub(() => Promise.resolve()),
    cancelJob: createStub(() => Promise.resolve())
  }
  return model
}

test('single run idle: non-boolean rejectWhenBusy is a TypeError, never admitted', async (t) => {
  const invalidValues = [
    ['string', 'false'],
    ['number', 0],
    ['object', {}]
  ]

  for (const [label, value] of invalidValues) {
    const model = createModel({ activeJobs: 0 })

    // exception.all: TypeError is opted out of plain t.exception by brittle.
    await t.exception.all(
      () => model.run([{ role: 'user', content: 'a' }], { rejectWhenBusy: value }),
      /rejectWhenBusy must be a boolean/,
      `${label} rejectWhenBusy must throw a TypeError even while idle`
    )
    t.is(
      model.addon.runJob.called,
      false,
      `a run with ${label} rejectWhenBusy must never reach native admission`
    )
  }
})

test('single run with null runOptions fails options validation, not property access', async (t) => {
  const model = createModel({ activeJobs: 0 })

  await t.exception.all(
    () => model.run([{ role: 'user', content: 'a' }], null),
    /Run options must be an object when provided/,
    'null run options must hit the options-must-be-object TypeError'
  )
  t.is(model.addon.runJob.called, false, 'a run with null options must never reach admission')
})

test('single run busy: a truthy non-boolean must not act like rejectWhenBusy: true', async (t) => {
  const model = createModel({ activeJobs: PARALLEL })

  await t.exception.all(
    () => model.run([{ role: 'user', content: 'a' }], { rejectWhenBusy: 'false' }),
    /rejectWhenBusy must be a boolean/,
    'string "false" at capacity must throw a TypeError, not RUN_BUSY'
  )
  t.is(model.addon.runJob.called, false, 'an invalid run must never reach native admission')
})

test('valid rejectWhenBusy values keep the current admission behavior', async (t) => {
  const busyTrue = createModel({ activeJobs: PARALLEL })
  await t.exception(
    () => busyTrue.run([{ role: 'user', content: 'a' }], { rejectWhenBusy: true }),
    /already set or being processed/,
    'true at capacity must fail fast with RUN_BUSY'
  )
  t.is(busyTrue.addon.runJob.called, false, 'a refused run must never reach the native queue')

  const busyFalse = createModel({ activeJobs: PARALLEL })
  await busyFalse.run([{ role: 'user', content: 'a' }], { rejectWhenBusy: false })
  t.is(busyFalse.addon.runJob.callCount, 1, 'false at capacity must queue via the scheduler')

  const busyDefaultQueue = createModel({ activeJobs: PARALLEL })
  await busyDefaultQueue.run([{ role: 'user', content: 'a' }])
  t.is(
    busyDefaultQueue.addon.runJob.callCount,
    1,
    'undefined must fall back to the instance default (queue at parallel >= 2)'
  )

  const busyDefaultReject = createModel({ activeJobs: PARALLEL, opts: { rejectWhenBusy: true } })
  await t.exception(
    () => busyDefaultReject.run([{ role: 'user', content: 'a' }]),
    /already set or being processed/,
    'undefined must fall back to the instance-level rejectWhenBusy: true'
  )
  t.is(busyDefaultReject.addon.runJob.called, false, 'a refused run must never reach admission')
})

test('batch item with non-boolean rejectWhenBusy is a TypeError before admission', async (t) => {
  for (const activeJobs of [0, PARALLEL]) {
    const state = activeJobs === 0 ? 'idle' : 'busy'
    const model = createModel({ activeJobs })

    await t.exception.all(
      () =>
        model.run([
          [{ role: 'user', content: 'a' }],
          { prompt: [{ role: 'user', content: 'b' }], runOptions: { rejectWhenBusy: 'yes' } }
        ]),
      /rejectWhenBusy must be a boolean/,
      `a non-boolean batch policy must throw a TypeError while ${state}`
    )
    t.is(
      model.addon.runJob.called,
      false,
      `an invalid batch must never reach native admission while ${state}`
    )
  }
})

test('constructor rejects a non-boolean opts.rejectWhenBusy', (t) => {
  t.exception.all(
    () =>
      new LlmLlamacpp({
        files: { model: ['/tmp/test.gguf'] },
        config: { device: 'cpu', ctx_size: '256', parallel: PARALLEL },
        opts: { rejectWhenBusy: 'nope' },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
      }),
    /rejectWhenBusy must be a boolean/,
    'the instance-wide admission policy must be validated at construction'
  )
})
