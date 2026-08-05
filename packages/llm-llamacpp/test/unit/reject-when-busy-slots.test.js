'use strict'

// Admission capacity is consumed in scheduler SLOTS, but a batch run of N
// prompts is ONE job. Gating `rejectWhenBusy` on the job count therefore reads
// a full pool as 1 and admits a caller who explicitly asked to fail fast — it
// then blocks in the scheduler's queue behind the batch, which is exactly what
// `rejectWhenBusy: true` promises never to do ("never queues", index.js).
//
// These tests drive the two counters independently through the addon stub, so
// they pin the gate itself rather than any particular scheduler behaviour.

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function createStub(defaultImpl = () => {}) {
  let impl = defaultImpl
  const fn = function (...args) {
    fn.called = true
    fn.callCount += 1
    fn.calls.push(args)
    return impl.apply(this, args)
  }
  fn.called = false
  fn.callCount = 0
  fn.calls = []
  fn.callsFake = (newImpl) => {
    impl = newImpl || (() => {})
    return fn
  }
  return fn
}

/// `activeSlots: null` omits the method entirely, standing in for an older
/// binding that never exported it.
function createModel({ parallel = 4, activeJobs = 0, activeSlots = 0, opts = {} } = {}) {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel },
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
  if (activeSlots !== null) {
    model.addon.activeSlots = () => activeSlots
  }
  return model
}

const PROMPT = [{ role: 'user', content: 'hi' }]

test('fail-fast single run is refused when slots are full but the job count is not', async (t) => {
  // parallel: 4 with one in-flight batch of 4 prompts: one job, four slots.
  const model = createModel({ parallel: 4, activeJobs: 1, activeSlots: 4 })

  await t.exception(
    model.run(PROMPT, { rejectWhenBusy: true }),
    /already set or being processed/,
    'a full slot pool must throw RUN_BUSY even though activeJobs() is only 1'
  )
  t.absent(model.addon.runJob.called, 'the refused run must never reach the native scheduler')
})

test('fail-fast batch run is refused when slots are full but the job count is not', async (t) => {
  const model = createModel({ parallel: 4, activeJobs: 1, activeSlots: 4 })

  await t.exception(
    model.run([
      { prompt: PROMPT, runOptions: { rejectWhenBusy: true } },
      { prompt: PROMPT, runOptions: { rejectWhenBusy: true } }
    ]),
    /already set or being processed/,
    'the batch path must gate on slots too'
  )
  t.absent(model.addon.runJob.called, 'the refused batch must never be submitted')
})

test('a batch wider than the pool is still admitted on an idle model', async (t) => {
  // Occupancy is read BEFORE submission, so the group must not be measured
  // against its own size — 8 prompts at parallel: 4 queue internally by design.
  const model = createModel({ parallel: 4, activeJobs: 0, activeSlots: 0 })

  const items = []
  for (let i = 0; i < 8; i++) {
    items.push({ prompt: PROMPT, runOptions: { rejectWhenBusy: true } })
  }
  await model.run(items)
  t.ok(model.addon.runJob.called, 'an idle model must admit a batch wider than parallel')
})

test('parallel: 1 keeps failing fast on the job count, where slots are always 0', async (t) => {
  // No batch scheduler exists at parallel: 1, so activeSlots() is 0 forever.
  // Gating on slots alone would silently destroy the documented default.
  const busy = createModel({ parallel: 1, activeJobs: 1, activeSlots: 0 })
  await t.exception(
    busy.run(PROMPT),
    /already set or being processed/,
    'parallel: 1 with a job in flight must still throw RUN_BUSY'
  )
  t.absent(busy.addon.runJob.called, 'the refused run must never be submitted')

  const idle = createModel({ parallel: 1, activeJobs: 0, activeSlots: 0 })
  await idle.run(PROMPT)
  t.ok(idle.addon.runJob.called, 'an idle parallel: 1 model must still admit')
})

test('an addon without activeSlots behaves exactly as before', async (t) => {
  const busy = createModel({ parallel: 4, activeJobs: 4, activeSlots: null })
  await t.exception(
    busy.run(PROMPT, { rejectWhenBusy: true }),
    /already set or being processed/,
    'a legacy binding must still fail fast on the job count'
  )

  const idle = createModel({ parallel: 4, activeJobs: 1, activeSlots: null })
  await idle.run(PROMPT, { rejectWhenBusy: true })
  t.ok(idle.addon.runJob.called, 'a legacy binding below capacity must still be admitted')
})

test('rejectWhenBusy: false queues instead of failing when slots are full', async (t) => {
  // The gate is opt-in; a queueing caller is unaffected by slot occupancy.
  const model = createModel({ parallel: 4, activeJobs: 1, activeSlots: 4 })
  await model.run(PROMPT, { rejectWhenBusy: false })
  t.ok(model.addon.runJob.called, 'rejectWhenBusy: false must still be admitted')
})

// A finetune is exclusive: it saturates the model at any `parallel`, yet it
// occupies no slot and counts as one job. Neither counter therefore reports a
// full pool for `parallel >= 2`, so the gate needs the finetune handler itself.
// `_run` only serializes admission, not a job's lifetime — finetune() returns
// as soon as the native side accepts it — so a run() really can arrive here
// while a finetune is still executing.

test('fail-fast run is refused while a finetune is active, though counters show headroom', async (t) => {
  const model = createModel({ parallel: 4, activeJobs: 1, activeSlots: 0 })
  model._finetuneJob.start()

  await t.exception(
    model.run(PROMPT, { rejectWhenBusy: true }),
    /already set or being processed/,
    'an exclusive finetune must saturate the pool even at parallel: 4'
  )
  t.absent(
    model.addon.runJob.called,
    'refused at the JS gate, never submitted to the native scheduler'
  )

  // Negative control: the gate must reopen once the finetune settles, so this
  // pins a live-finetune check rather than a permanently closed gate.
  model._finetuneJob.end(null, { op: 'finetune', status: 'SUCCESS' })
  await model.run(PROMPT, { rejectWhenBusy: true })
  t.ok(model.addon.runJob.called, 'the gate reopens when the finetune response settles')
})

test('fail-fast batch run is refused while a finetune is active', async (t) => {
  // Both gates share _atCapacity(), so the batch path must agree.
  const model = createModel({ parallel: 4, activeJobs: 1, activeSlots: 0 })
  model._finetuneJob.start()

  await t.exception(
    model.run([
      { prompt: PROMPT, runOptions: { rejectWhenBusy: true } },
      { prompt: PROMPT, runOptions: { rejectWhenBusy: true } }
    ]),
    /already set or being processed/,
    'the batch fast-fail path must see the finetune too'
  )
  t.absent(model.addon.runJob.called, 'the refused batch must never be submitted')
})

// `rejectWhenBusy` exists so callers can handle a busy refusal, and the docs
// name that condition RUN_BUSY — so it has to be branchable without matching
// the message, which is prose. Every construction site goes through
// batchHandler's runBusyError(), so the code cannot drift per site.

test('a busy refusal carries the RUN_BUSY code on every admission path', async (t) => {
  const paths = [
    {
      label: 'single run, slots full',
      model: () => createModel({ parallel: 4, activeJobs: 1, activeSlots: 4 }),
      run: (m) => m.run(PROMPT, { rejectWhenBusy: true })
    },
    {
      label: 'single run, finetune active',
      model: () => {
        const m = createModel({ parallel: 4, activeJobs: 1, activeSlots: 0 })
        m._finetuneJob.start()
        return m
      },
      run: (m) => m.run(PROMPT, { rejectWhenBusy: true })
    },
    {
      label: 'batch run, slots full',
      model: () => createModel({ parallel: 4, activeJobs: 1, activeSlots: 4 }),
      run: (m) => m.run([{ prompt: PROMPT, runOptions: { rejectWhenBusy: true } }])
    },
    {
      label: 'native refusal (accepted: false)',
      model: () => {
        const m = createModel({ parallel: 4, activeJobs: 0, activeSlots: 0 })
        m.addon.runJob.callsFake(() => ({ accepted: false }))
        return m
      },
      run: (m) => m.run(PROMPT, { rejectWhenBusy: false })
    }
  ]

  for (const { label, model: make, run } of paths) {
    let err = null
    try {
      await run(make())
    } catch (caught) {
      err = caught
    }
    t.is(err?.code, 'RUN_BUSY', `${label}: refusal must expose code RUN_BUSY`)
    t.ok(
      /already set or being processed/.test(err?.message ?? ''),
      `${label}: the human-readable message is kept alongside the code`
    )
  }
})
