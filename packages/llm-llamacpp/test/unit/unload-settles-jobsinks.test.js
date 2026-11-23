'use strict'

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')
const { LlamaInterface } = require('../../addon.js')

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

test('LlamaInterface.unload() waits for asynchronous binding cleanup', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    let finishDestroy
    const destroyed = new Promise((resolve) => {
      finishDestroy = resolve
    })
    const binding = {
      createInstance: () => ({}),
      destroyInstance: () => destroyed
    }
    const addon = new LlamaInterface(
      binding,
      { path: '/tmp/test.gguf', projectionPath: '', config: {} },
      () => {}
    )

    let settled = false
    const unloading = addon.unload().then(() => {
      settled = true
    })
    await Promise.resolve()
    t.absent(settled, `cleanup is still pending, iteration ${iteration + 1}`)

    finishDestroy()
    await unloading
    t.ok(settled, `cleanup finished before unload resolved, iteration ${iteration + 1}`)
  }
})

test('LlamaInterface.unload() preserves failed cleanup for a public retry', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = {}
    let attempts = 0
    const binding = {
      createInstance: () => handle,
      activeJobs: (candidate) => (candidate === handle ? 1 : 0),
      destroyInstance(candidate) {
        t.is(candidate, handle, `same handle, iteration ${iteration + 1}`)
        attempts++
        if (attempts === 1) {
          if (iteration % 2 === 0) throw new Error('cleanup failed')
          return Promise.reject(new Error('cleanup failed'))
        }
        return Promise.resolve()
      }
    }
    const addon = new LlamaInterface(
      binding,
      { path: '/tmp/test.gguf', projectionPath: '', config: {} },
      () => {}
    )

    await t.exception.all(() => addon.unload(), /cleanup failed/)
    t.is(addon.activeJobs(), 1, `failed cleanup remains reachable, iteration ${iteration + 1}`)
    await addon.unload()
    t.is(attempts, 2, `cleanup retried, iteration ${iteration + 1}`)
    t.is(addon.activeJobs(), 0, `successful cleanup clears handle, iteration ${iteration + 1}`)
  }
})

test('LlamaInterface.unload() shares one in-flight cleanup', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    let finishDestroy
    let attempts = 0
    const destroyed = new Promise((resolve) => {
      finishDestroy = resolve
    })
    const binding = {
      createInstance: () => ({}),
      destroyInstance() {
        attempts++
        return destroyed
      }
    }
    const addon = new LlamaInterface(
      binding,
      { path: '/tmp/test.gguf', projectionPath: '', config: {} },
      () => {}
    )

    const first = addon.unload()
    const second = addon.unload()
    t.is(second, first, `concurrent callers share cleanup, iteration ${iteration + 1}`)
    t.is(attempts, 1, `cleanup starts once, iteration ${iteration + 1}`)
    finishDestroy()
    await Promise.all([first, second])
  }
})

test('unload rejection still permits a fresh load', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const model = createMultiJobModel()
    model.state.configLoaded = true
    const stale = model.addon
    let staleCleanupAttempts = 0
    stale.unload.callsFake(() => {
      staleCleanupAttempts++
      if (staleCleanupAttempts === 1) return Promise.reject(new Error('cleanup failed'))
      return Promise.resolve()
    })

    await t.exception.all(() => model.unload(), /cleanup failed/)
    t.is(model.addon, null, `addon reset, iteration ${iteration + 1}`)
    t.absent(model.state.configLoaded, `load state reset, iteration ${iteration + 1}`)

    const activate = createStub(() => Promise.resolve())
    const fresh = { activate, unload: createStub(() => Promise.resolve()) }
    model._createAddon = createStub(() => fresh)
    await model.load()

    t.is(model.addon, fresh, `fresh addon created, iteration ${iteration + 1}`)
    t.is(activate.callCount, 1, `fresh addon activated, iteration ${iteration + 1}`)
    t.ok(model.state.configLoaded, `fresh load completed, iteration ${iteration + 1}`)
    await model.unload()
    t.is(staleCleanupAttempts, 2, `failed cleanup retried, iteration ${iteration + 1}`)
    t.is(fresh.unload.callCount, 1, `fresh addon cleaned, iteration ${iteration + 1}`)
  }
})
