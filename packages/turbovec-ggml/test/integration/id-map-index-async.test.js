'use strict'

// How calls run: off the JS thread, in call order per index, with inputs
// copied at call time, and cancellable with an AbortSignal. What each call
// computes is covered by id-map-index.test.js.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const TARGET_ARCH = os.arch()
const IS_MOBILE = os.platform() === 'ios' || os.platform() === 'android'
const SUPPORTS_TURBOVEC = TARGET_ARCH === 's390x' || TARGET_ARCH.includes('64')

const IdMapIndex = require('@qvac/turbovec-ggml/idMapIndex')

const DIM = 16
const N = 10
// Large enough that an IVF build runs for a while on any test host, small
// enough to keep the suite fast on mobile.
const BUSY_ROWS = 20_000
const BUSY_DIM = 64
const BUSY_LISTS = 128
const BUSY_ITERS = 5
const RESERVED_ID = 0xffffffffffffffffn
// The fewest rows for which turning staged search on builds its cache, at a
// dimension divisible by 32.
const STAGED_ROWS = 32_768
const STAGED_DIM = 256

// Native errors are inference-addon-cpp StatusErrors: their `code` names the
// addon and the error category.
function errorCode(category) {
  return `[ TurboVec :: ${category} ]`
}

let tmpCounter = 0
function tmpPath(name) {
  const pid = os.pid ? os.pid() : 0
  tmpCounter += 1
  return path.join(os.tmpdir(), `${name}-${pid}-${Date.now()}-${tmpCounter}.tvim`)
}

function removeFile(file) {
  for (const artifact of [file, `${file}.lock`]) {
    if (fs.existsSync(artifact)) fs.unlinkSync(artifact)
  }
}

function unitVec(i, dim = DIM) {
  const vector = new Float32Array(dim)
  vector[i % dim] = 1
  return vector
}

function unitBatch(n = N, dim = DIM) {
  const vectors = new Float32Array(n * dim)
  const ids = new BigUint64Array(n)
  for (let i = 0; i < n; i++) {
    vectors.set(unitVec(i, dim), i * dim)
    ids[i] = BigInt(i + 1)
  }
  return { vectors, ids }
}

// Deterministic pseudo-random rows, so every run builds the same index.
function randomBatch(n, dim, seed = 0x5eed) {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000 - 0.5
  }
  const vectors = new Float32Array(n * dim)
  for (let i = 0; i < vectors.length; i++) vectors[i] = next()
  const ids = new BigUint64Array(n)
  for (let i = 0; i < n; i++) ids[i] = BigInt(i + 1)
  return { vectors, ids }
}

async function filledIndex(options = { dim: DIM, bitWidth: 32 }) {
  const idx = new IdMapIndex(options)
  const { vectors, ids } = unitBatch()
  await idx.addWithIds(vectors, ids)
  return idx
}

async function busyIndex() {
  const idx = new IdMapIndex({ dim: BUSY_DIM, bitWidth: 32 })
  const { vectors, ids } = randomBatch(BUSY_ROWS, BUSY_DIM)
  await idx.addWithIds(vectors, ids)
  return idx
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

function syncError(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

// Blocks the JS thread for `ms`. A native job started just before is then
// sure to have started on its worker thread, while its completion cannot have
// reached JS yet. An abort right after this hits a running (or finished) job,
// not a waiting one, which would be skipped instead.
function holdJsThread(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // spin
  }
}

// A minimal AbortController: Bare has none built in, and the SDK passes
// signals from bare-abort-controller, which have this shape. Counts its
// listeners so tests can check that none are left behind.
function createController() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) {
      if (type === 'abort') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener)
    },
    get listenerCount() {
      return listeners.size
    }
  }
  return {
    signal,
    abort(reason) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason === undefined ? abortError() : reason
      for (const listener of [...listeners]) {
        listeners.delete(listener)
        listener()
      }
    }
  }
}

function abortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

// Records the native frees the index makes, in order. Desktop only: the
// relative binding path does not resolve after the mobile test app copies
// the integration tests.
function recordFrees(t) {
  const binding = require('../../binding')
  const original = {
    idx_dispose: binding.idx_dispose,
    idx_filter_dispose: binding.idx_filter_dispose
  }
  const frees = []
  binding.idx_dispose = (handle) => {
    frees.push('index')
    return original.idx_dispose(handle)
  }
  binding.idx_filter_dispose = (handle) => {
    frees.push('filter')
    return original.idx_filter_dispose(handle)
  }
  t.teardown(() => Object.assign(binding, original))
  return frees
}

test('IdMapIndex async: bad arguments reject instead of throwing', async (t) => {
  const idx = await filledIndex()
  const filter = await idx.prepareFilter(new BigUint64Array([1n]))
  const calls = {
    search: () => idx.search([1, 2], 1),
    'search k': () => idx.search(unitVec(0), 0),
    searchFiltered: () => idx.searchFiltered(unitVec(0), 1, [1]),
    'IdMapIndexFilter#search': () => filter.search([1], 1),
    addWithIds: () => idx.addWithIds(unitVec(0), new BigUint64Array(2)),
    addLogged: () => idx.addLogged(unitVec(0), new BigUint64Array(2), 'delta'),
    prepareFilter: () => idx.prepareFilter([1]),
    buildIvf: () => idx.buildIvf(0),
    searchIvf: () => idx.searchIvf(unitVec(0), 1, 0),
    remove: () => idx.remove(1),
    removeLogged: () => idx.removeLogged(1, 'delta'),
    contains: () => idx.contains(1),
    setStagedSearch: () => idx.setStagedSearch('yes'),
    write: () => idx.write(''),
    compactDelta: () => idx.compactDelta('', 'delta'),
    load: () => IdMapIndex.load(''),
    loadMmap: () => IdMapIndex.loadMmap(''),
    loadWithDelta: () => IdMapIndex.loadWithDelta('', ''),
    'options type': () => idx.search(unitVec(0), 1, 5),
    'options.signal': () => idx.search(unitVec(0), 1, { signal: {} })
  }
  for (const [name, call] of Object.entries(calls)) {
    let promise = null
    t.execution(() => {
      promise = call()
    }, `${name} does not throw synchronously`)
    t.ok(await rejection(promise), `${name} rejects`)
  }
  t.is(idx.length, N, 'the index is untouched')
  filter.dispose()
  await idx.dispose()
})

// Every call that reads or changes the index is async: none returns its
// result directly.
test('IdMapIndex async: every index call returns a promise', async (t) => {
  const file = tmpPath('id-map-index-every-call')
  const snapshotFile = tmpPath('id-map-index-every-call-snapshot')
  const delta = `${snapshotFile}.delta`
  const idx = await filledIndex()
  const logged = await filledIndex()
  try {
    await logged.write(snapshotFile)
    await idx.write(file)
    const filter = await idx.prepareFilter(new BigUint64Array([1n]))
    const loaded = []
    const calls = {
      addWithIds: () => idx.addWithIds(unitVec(0), new BigUint64Array([100n])),
      search: () => idx.search(unitVec(0), 1),
      searchFiltered: () => idx.searchFiltered(unitVec(0), 1, new BigUint64Array([1n])),
      'IdMapIndexFilter#search': () => filter.search(unitVec(0), 1),
      prepareFilter: () => idx.prepareFilter(new BigUint64Array([1n])),
      contains: () => idx.contains(1n),
      remove: () => idx.remove(100n),
      compact: () => idx.compact(),
      buildIvf: () => idx.buildIvf(1),
      searchIvf: () => idx.searchIvf(unitVec(0), 1, 1),
      prepare: () => idx.prepare(),
      setStagedSearch: () => idx.setStagedSearch(false),
      write: () => idx.write(file),
      addLogged: () => logged.addLogged(unitVec(0), new BigUint64Array([200n]), delta),
      removeLogged: () => logged.removeLogged(200n, delta),
      compactDelta: () => logged.compactDelta(snapshotFile, delta),
      load: () => IdMapIndex.load(file).then((i) => loaded.push(i)),
      loadMmap: () => IdMapIndex.loadMmap(file).then((i) => loaded.push(i)),
      loadWithDelta: () =>
        IdMapIndex.loadWithDelta(file, `${file}.delta`).then((i) => loaded.push(i))
    }
    for (const [name, call] of Object.entries(calls)) {
      const result = call()
      t.ok(result instanceof Promise, `${name} returns a promise`)
      await rejection(result)
    }
    const disposed = filter.dispose()
    t.ok(disposed instanceof Promise, 'IdMapIndexFilter#dispose returns a promise')
    await disposed
    for (const index of loaded) await index.dispose()
  } finally {
    const dispose = idx.dispose()
    t.ok(dispose instanceof Promise, 'dispose returns a promise')
    await dispose
    await logged.dispose()
    for (const f of [file, snapshotFile, delta, `${file}.delta`]) removeFile(f)
  }
})

test(
  'IdMapIndex async: dispose rejects when freeing the index fails',
  { skip: IS_MOBILE },
  async (t) => {
    const binding = require('../../binding')
    const original = binding.idx_dispose
    t.teardown(() => {
      binding.idx_dispose = original
    })
    const failure = new Error('free failed')

    const idle = await filledIndex()
    binding.idx_dispose = () => {
      throw failure
    }
    let error = null
    t.execution(() => {
      error = rejection(idle.dispose())
    }, 'an idle dispose does not throw synchronously')
    t.is(await error, failure, 'and rejects with the error')

    const busy = await busyIndex()
    const build = busy.buildIvf(BUSY_LISTS, BUSY_ITERS)
    t.is(await rejection(busy.dispose()), failure, 'a dispose queued behind a build rejects too')
    await build
    // Both native indexes are freed by their handles' finalizers.
  }
)

test('IdMapIndex async: operations on one index run in call order', async (t) => {
  const idx = new IdMapIndex({ dim: DIM, bitWidth: 32 })
  const { vectors, ids } = unitBatch()
  const order = []
  const track = (name, promise) =>
    promise.then((value) => {
      order.push(name)
      return value
    })
  const add = track('add', idx.addWithIds(vectors, ids))
  const search = track('search', idx.search(unitVec(4), 1))
  const remove = track('remove', idx.remove(5n))
  const contains = track('contains', idx.contains(5n))
  const after = track('after', idx.search(unitVec(4), 1))
  const [, found, removed, present, gone] = await Promise.all([
    add,
    search,
    remove,
    contains,
    after
  ])
  t.alike(order, ['add', 'search', 'remove', 'contains', 'after'], 'promises settle in call order')
  t.is(found.ids[0], 5n, 'a search queued after an add sees it')
  t.is(removed, true, 'the remove ran after the add')
  t.is(present, false, 'contains queued after a remove sees it')
  t.not(gone.ids[0], 5n, 'a search queued after a remove does not see the id')
  await idx.dispose()
})

test('IdMapIndex async: getters work while calls are pending', async (t) => {
  const idx = await filledIndex()
  const add = idx.addWithIds(unitVec(3), new BigUint64Array([50n]))
  for (const [name, read] of Object.entries({
    length: () => idx.length,
    dim: () => idx.dim,
    bitWidth: () => idx.bitWidth,
    calibrated: () => idx.calibrated,
    stagedSearch: () => idx.stagedSearch
  })) {
    t.is(syncError(read), null, `${name} does not throw`)
  }
  t.is(idx.length, N, 'length reports the calls that have finished')
  await add
  t.is(idx.length, N + 1, 'and follows the add once it finishes')
  await idx.dispose()
})

test('IdMapIndex async: setStagedSearch applies to the searches queued after it', async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    t.pass('TurboVec needs a 64-bit target')
    return
  }
  const idx = new IdMapIndex({ dim: 128, storage: 'turbovec-q4' })
  const { vectors, ids } = randomBatch(16, 128, 21)
  const add = idx.addWithIds(vectors, ids)
  const on = idx.setStagedSearch(true)
  t.is(idx.stagedSearch, false, 'the setting changes when its turn comes')
  await add
  await on
  t.is(idx.stagedSearch, true, 'and is reported once applied')
  await idx.dispose()
})

// Turning staged search on builds its cache across the whole index: bulk
// work, run on a worker thread like a build.
test('IdMapIndex async: setStagedSearch leaves the JS thread free', async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    t.pass('TurboVec needs a 64-bit target')
    return
  }
  const idx = new IdMapIndex({ dim: STAGED_DIM, storage: 'turbovec-q4' })
  const { vectors, ids } = randomBatch(STAGED_ROWS, STAGED_DIM, 31)
  await idx.addWithIds(vectors, ids)
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 1)
  let immediateRan = false
  setImmediate(() => {
    immediateRan = true
  })
  try {
    // Called on an idle index, so the call starts at once: on the JS thread
    // it would finish before the event loop runs the immediate.
    await idx.setStagedSearch(true)
    t.ok(immediateRan, `the event loop ran while the cache was built (${ticks} timer ticks)`)
    t.is(idx.stagedSearch, true, 'staged search is on')
    const hits = await idx.search(randomBatch(1, STAGED_DIM, 32).vectors, 5)
    t.is(hits.k, 5, 'and the index answers a search')
  } finally {
    clearInterval(timer)
    await idx.dispose()
  }
})

test('IdMapIndex async: an IVF build leaves the JS thread free', async (t) => {
  const big = await busyIndex()
  const small = await filledIndex()
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 1)
  let buildDone = false
  try {
    const build = big.buildIvf(BUSY_LISTS, BUSY_ITERS).then(() => {
      buildDone = true
    })
    const result = await small.search(unitVec(2), 1)
    t.is(result.ids[0], 3n, 'another index answers a search')
    t.absent(buildDone, 'before the build on the first index finishes')
    await build
    t.ok(ticks > 0, `timers kept firing during the build (${ticks} ticks)`)
    const hits = await big.searchIvf(randomBatch(1, BUSY_DIM, 7).vectors, 5, 8)
    t.is(hits.k, 5, 'the built IVF state is searchable')
  } finally {
    clearInterval(timer)
    await small.dispose()
    await big.dispose()
  }
})

test('IdMapIndex async: dispose during a build', async (t) => {
  const idx = await busyIndex()
  const build = idx.buildIvf(BUSY_LISTS, BUSY_ITERS)
  // Handled right away: it rejects as soon as the build settles.
  const queued = rejection(idx.search(randomBatch(1, BUSY_DIM, 3).vectors, 1))
  const disposed = idx.dispose()
  t.execution(() => idx.dispose(), 'dispose stays idempotent')
  t.is(
    syncError(() => idx.length)?.message,
    'IdMapIndex has been disposed',
    'getters throw at once'
  )

  await build
  t.pass('the running build still finishes')
  const error = await queued
  t.is(error && error.message, 'IdMapIndex has been disposed', 'a queued search rejects')
  await disposed
  t.pass('dispose() resolves once the index is freed')
  t.ok(await rejection(idx.search(randomBatch(1, BUSY_DIM).vectors, 1)), 'later calls reject')
})

test('IdMapIndex async: dispose resolves after the running call', async (t) => {
  const idx = await filledIndex()
  const search = idx.search(unitVec(1), 1)
  await idx.dispose()
  t.is((await search).ids[0], 2n, 'the running search finished')
})

test('IdMapIndex async: filters and queued mutations', async (t) => {
  const idx = await filledIndex()
  const filter = await idx.prepareFilter(new BigUint64Array([1n, 2n]))
  const search = filter.search(unitVec(1), 1)
  filter.dispose()
  t.is((await search).ids[0], 2n, 'a filter disposed mid-search still answers that search')
  t.ok(await rejection(filter.search(unitVec(1), 1)), 'later filter searches reject')

  const second = await idx.prepareFilter(new BigUint64Array([1n, 2n]))
  const add = idx.addWithIds(unitVec(5), new BigUint64Array([50n]))
  const stale = rejection(second.search(unitVec(1), 1))
  await add
  const error = await stale
  t.is(
    error && error.message,
    'IdMapIndexFilter has been disposed',
    'a filter search queued after a mutation rejects'
  )
  await idx.dispose()
})

// fabric requires an index to outlive its filters.
test('IdMapIndex async: filters are freed before their index', { skip: IS_MOBILE }, async (t) => {
  const frees = recordFrees(t)

  // A mutation invalidates every filter; disposing right after it must not
  // overtake those frees.
  const idx = await filledIndex()
  // Held, so GC cannot free any of them first.
  const filters = []
  for (let i = 0; i < 8; i++) filters.push(await idx.prepareFilter(new BigUint64Array([1n])))
  await idx.addWithIds(unitVec(4), new BigUint64Array([60n]))
  await idx.dispose()
  t.alike(frees, [...Array(filters.length).fill('filter'), 'index'], 'after a mutation')

  // Filters disposed while a call runs are freed after that call, one by one.
  // Disposing the index right after awaiting the call must wait for them.
  frees.length = 0
  const other = await filledIndex()
  const held = []
  for (let i = 0; i < 8; i++) held.push(await other.prepareFilter(new BigUint64Array([1n])))
  const search = other.search(unitVec(0), 1)
  for (const filter of held) filter.dispose()
  await search
  await other.dispose()
  t.alike(frees, [...Array(held.length).fill('filter'), 'index'], 'after filters disposed mid-call')
})

test(
  'IdMapIndex async: a filter dispose resolves once the native filter is freed',
  { skip: IS_MOBILE },
  async (t) => {
    const frees = recordFrees(t)
    const idx = await filledIndex()
    const filter = await idx.prepareFilter(new BigUint64Array([1n]))
    const search = idx.search(unitVec(0), 1)
    const disposed = filter.dispose()
    t.is(filter.dispose(), disposed, 'a second dispose returns the same promise')
    t.alike(frees, [], 'the free waits behind the running search')
    await disposed
    t.alike(frees, ['filter'], 'and has happened once dispose resolves')
    await search

    // A mutation frees the index's filters at its turn in the queue.
    const invalidated = await idx.prepareFilter(new BigUint64Array([2n]))
    await idx.addWithIds(unitVec(5), new BigUint64Array([70n]))
    const freed = invalidated.dispose()
    t.ok(freed instanceof Promise, 'a filter the index already freed returns a promise')
    t.is(await freed, undefined, 'which resolves')

    const binding = require('../../binding')
    const failure = new Error('free failed')
    const failing = await idx.prepareFilter(new BigUint64Array([3n]))
    const free = binding.idx_filter_dispose
    binding.idx_filter_dispose = () => {
      throw failure
    }
    let error = null
    t.execution(() => {
      error = rejection(failing.dispose())
    }, 'a failing dispose does not throw synchronously')
    t.is(await error, failure, 'and rejects with the error')
    binding.idx_filter_dispose = free
    // The native filter is freed by its handle's finalizer.
    await idx.dispose()
  }
)

test('IdMapIndex async: native async calls refuse a busy index', { skip: IS_MOBILE }, async (t) => {
  const binding = require('../../binding')
  const handle = binding.idx_create({ dim: DIM, storage: 'f32' })
  const { vectors, ids } = unitBatch()
  await binding.idx_add_async(handle, vectors, ids)
  const running = binding.idx_search_async(handle, unitVec(0), 1)
  for (const [name, call] of Object.entries({
    'a second job': () => binding.idx_search_async(handle, unitVec(0), 1),
    'a sync read': () => binding.idx_len(handle),
    dispose: () => binding.idx_dispose(handle)
  })) {
    const error = syncError(call)
    t.is(error && error.code, errorCode('Busy'), `${name} is refused`)
  }
  t.is((await running).ids[0], 1n, 'the running job finishes')
  t.is(binding.idx_len(handle), N, 'the index is idle again')
  binding.idx_dispose(handle)
})

test('IdMapIndex async: prepareFilter rejects when the index is disposed meanwhile', async (t) => {
  const idx = await filledIndex()
  const pending = rejection(idx.prepareFilter(new BigUint64Array([1n, 2n])))
  const disposed = idx.dispose()
  const error = await pending
  t.is(error && error.message, 'IdMapIndex has been disposed', 'the filter is not handed out')
  await disposed
})

test(
  'IdMapIndex async: a failed native call leaves the index idle',
  { skip: IS_MOBILE },
  async (t) => {
    const binding = require('../../binding')
    const handle = binding.idx_create({ dim: DIM, storage: 'f32' })
    const { vectors, ids } = unitBatch()
    await binding.idx_add_async(handle, vectors, ids)
    const error = await rejection(binding.idx_add_async(handle, vectors, ids))
    t.is(error && error.code, errorCode('DuplicateId'), 'a duplicate add rejects')
    t.is(binding.idx_len(handle), N, 'and the index is idle again')
    binding.idx_dispose(handle)
  }
)

// A job holds the native index itself, so collecting the JS handle while the
// job runs cannot free the index under it. Needs `bare --expose-gc`, which
// `npm run test:integration` passes.
test(
  'IdMapIndex async: a running job keeps its index when the handle is collected',
  { skip: IS_MOBILE },
  async (t) => {
    if (typeof globalThis.gc !== 'function') {
      t.comment('skipped: run bare with --expose-gc')
      t.pass()
      return
    }
    const binding = require('../../binding')
    let collected = false
    const registry = new FinalizationRegistry(() => {
      collected = true
    })
    let handle = binding.idx_create({ dim: BUSY_DIM, storage: 'f32' })
    registry.register(handle, null)
    const { vectors, ids } = randomBatch(BUSY_ROWS, BUSY_DIM)
    await binding.idx_add_async(handle, vectors, ids)
    let buildDone = false
    const build = binding.idx_build_ivf_async(handle, BUSY_LISTS, BUSY_ITERS).then(() => {
      buildDone = true
    })
    handle = null
    for (let i = 0; i < 10 && !collected; i++) {
      globalThis.gc()
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    t.ok(collected, 'the handle is collected')
    t.absent(buildDone, 'while the build is still running')
    await build
    t.pass('and the build finishes on its index')
  }
)

// A job still waiting for a worker thread when its Bare environment shuts down
// is dropped, so the shutdown waits only for the job that is running.
test(
  'IdMapIndex async: a job still waiting at env shutdown never runs',
  { skip: IS_MOBILE },
  async (t) => {
    t.timeout(120_000)
    const Thread = require('bare-thread')
    const base = path.join(os.tmpdir(), `turbovec-ggml-teardown-${os.pid()}`)
    const ready = `${base}.ready`
    const written = `${base}.tvim`
    removeFile(ready)
    removeFile(written)

    const thread = new Thread(require.resolve('./teardown-worker.js'))
    let terminated = false
    try {
      for (let i = 0; i < 6000 && !fs.existsSync(ready); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      t.ok(fs.existsSync(ready), 'the worker started a build and queued a write behind it')
      thread.terminate()
      terminated = true
    } finally {
      if (!terminated) thread.terminate()
      // Waits for the running build, which the shutdown lets finish.
      thread.join()
    }
    t.absent(fs.existsSync(written), 'the queued write never ran')
    removeFile(ready)
    removeFile(written)
  }
)

test('IdMapIndex async: inputs are copied when the call is made', async (t) => {
  const idx = new IdMapIndex({ dim: DIM, bitWidth: 32 })
  const { vectors, ids } = unitBatch()
  const add = idx.addWithIds(vectors, ids)
  ids.fill(RESERVED_ID)
  vectors.fill(0)
  await add
  t.ok(
    (await idx.contains(1n)) && (await idx.contains(BigInt(N))),
    'the add used the ids it was called with'
  )
  t.absent(await idx.contains(RESERVED_ID), 'the reserved id was not added')

  const query = unitVec(6)
  const search = idx.search(query, 1)
  query.buffer.transfer()
  t.is(query.length, 0, 'the query buffer was detached')
  t.is((await search).ids[0], 7n, 'a search whose query was detached')

  const allowed = new BigUint64Array([7n])
  const filtered = idx.searchFiltered(unitVec(6), 1, allowed)
  allowed[0] = 3n
  t.is((await filtered).ids[0], 7n, 'the allow-list was copied')
  await idx.dispose()
})

// A queued operation's native call starts only after the operations ahead of
// it settle; the caller changes each input right after making the call.
test('IdMapIndex async: inputs of queued operations are copied when the call is made', async (t) => {
  const idx = await filledIndex()
  await idx.buildIvf(4, 2)

  const ahead = idx.search(unitVec(0), 1)
  const query = unitVec(6)
  const search = idx.search(query, 1)
  query.set(unitVec(2))
  const ivfQuery = unitVec(6)
  const ivf = idx.searchIvf(ivfQuery, 1, 4)
  ivfQuery.set(unitVec(2))
  const allowed = new BigUint64Array([7n])
  const filtered = idx.searchFiltered(unitVec(6), 1, allowed)
  allowed[0] = 3n
  const filterIds = new BigUint64Array([7n])
  const prepared = idx.prepareFilter(filterIds)
  filterIds[0] = 3n

  t.is((await ahead).ids[0], 1n, 'the operation ahead ran')
  t.is((await search).ids[0], 7n, 'search used the query it was called with')
  t.is((await ivf).ids[0], 7n, 'searchIvf used the query it was called with')
  t.is((await filtered).ids[0], 7n, 'searchFiltered used the allow-list it was called with')
  const filter = await prepared
  t.is(
    (await filter.search(unitVec(6), 1)).ids[0],
    7n,
    'prepareFilter used the ids it was called with'
  )

  const busy = idx.search(unitVec(0), 1)
  const filterQuery = unitVec(6)
  const filterSearch = filter.search(filterQuery, 1)
  filterQuery.buffer.transfer()
  const rows = unitVec(3)
  const ids = new BigUint64Array([50n])
  const add = idx.addWithIds(rows, ids)
  rows.fill(0)
  ids[0] = RESERVED_ID

  await busy
  t.is((await filterSearch).ids[0], 7n, 'filter.search used the query it was called with')
  await add
  t.absent(await idx.contains(RESERVED_ID), 'addWithIds did not add the reserved id')
  // Row 3 already holds unitVec(3): the new row is a second exact match only
  // when it was stored as passed.
  const scoreOf = (result, id) => result.scores[result.ids.indexOf(id)]
  t.ok(scoreOf(await idx.search(unitVec(3), 2), 50n) > 0.99, 'addWithIds stored its rows')
  await idx.dispose()

  // A written index takes logged or unlogged mutations, not both, so the
  // logged add gets an index of its own.
  const logged = await filledIndex()
  const snapshotPath = tmpPath('async-queued-copy')
  const deltaPath = snapshotPath.replace(/\.tvim$/, '.tvid')
  try {
    await logged.write(snapshotPath)
    const before = logged.search(unitVec(0), 1)
    const loggedRows = unitVec(4)
    const loggedIds = new BigUint64Array([60n])
    const append = logged.addLogged(loggedRows, loggedIds, deltaPath)
    loggedRows.fill(0)
    loggedIds[0] = RESERVED_ID
    await before
    await append
    t.absent(await logged.contains(RESERVED_ID), 'addLogged did not add the reserved id')
    t.ok(scoreOf(await logged.search(unitVec(4), 2), 60n) > 0.99, 'addLogged stored its rows')
  } finally {
    await logged.dispose()
    removeFile(snapshotPath)
    removeFile(deltaPath)
  }
})

test('IdMapIndex async: two builds do not hold up a search on a third index', async (t) => {
  const first = await busyIndex()
  const second = await busyIndex()
  const small = await filledIndex()
  let builds = 0
  try {
    const done = Promise.all([
      first.buildIvf(BUSY_LISTS, BUSY_ITERS).then(() => builds++),
      second.buildIvf(BUSY_LISTS, BUSY_ITERS).then(() => builds++)
    ])
    const result = await small.search(unitVec(2), 1)
    t.is(result.ids[0], 3n, 'the search answers')
    t.is(builds, 0, 'before either build finishes')
    await done
  } finally {
    await small.dispose()
    await second.dispose()
    await first.dispose()
  }
})

test('IdMapIndex abort: an aborted signal rejects without running the call', async (t) => {
  const idx = await filledIndex()
  const controller = createController()
  const reason = new Error('stop')
  controller.abort(reason)
  const { signal } = controller
  for (const [name, call] of Object.entries({
    addWithIds: () => idx.addWithIds(unitVec(3), new BigUint64Array([70n]), { signal }),
    search: () => idx.search(unitVec(0), 1, { signal }),
    contains: () => idx.contains(1n, { signal }),
    load: () => IdMapIndex.load(tmpPath('never-read'), { signal })
  })) {
    t.is(await rejection(call()), reason, `${name} rejects with the signal's reason`)
  }
  t.is(idx.length, N, 'the add did not run')
  t.absent(await idx.contains(70n), 'and the id is absent')
  await idx.dispose()
})

test('IdMapIndex abort: a call waiting in the queue is skipped', async (t) => {
  const idx = await busyIndex()
  const build = idx.buildIvf(BUSY_LISTS, BUSY_ITERS)
  let buildDone = false
  build.then(() => {
    buildDone = true
  })
  const controller = createController()
  const { signal } = controller
  const add = rejection(
    idx.addWithIds(unitVec(0, BUSY_DIM), new BigUint64Array([999_999n]), { signal })
  )
  const search = rejection(idx.search(unitVec(0, BUSY_DIM), 1, { signal }))
  controller.abort()

  const error = await add
  t.is(error && error.name, 'AbortError', 'the queued add rejects with an AbortError')
  t.absent(buildDone, 'without waiting for the build ahead of it')
  t.is((await search)?.name, 'AbortError', 'the queued search rejects too')
  await build
  t.absent(await idx.contains(999_999n), 'the add never ran')
  t.is(signal.listenerCount, 0, 'no abort listener is left on the signal')
  await idx.dispose()
})

test('IdMapIndex abort: a call waiting on a worker thread is skipped', async (t) => {
  // Another index's build holds the thread for long work. The add starts at
  // once on its idle index, so it waits for that thread, not in the queue.
  const busy = await busyIndex()
  const idle = await filledIndex()
  try {
    const build = busy.buildIvf(BUSY_LISTS, BUSY_ITERS)
    const controller = createController()
    const add = rejection(
      idle.addWithIds(unitVec(3), new BigUint64Array([70n]), { signal: controller.signal })
    )
    controller.abort()
    t.is((await add)?.name, 'AbortError', 'the add rejects at once')
    await build
    // contains() runs after the add's native job has settled.
    t.absent(await idle.contains(70n), 'the add never ran')
    t.is(idle.length, N, 'the index is unchanged')
  } finally {
    await idle.dispose()
    await busy.dispose()
  }
})

test(
  'IdMapIndex abort: works with a bare-abort-controller signal',
  { skip: IS_MOBILE },
  async (t) => {
    const { AbortController } = require('bare-abort-controller')
    const idx = await busyIndex()
    try {
      const build = idx.buildIvf(BUSY_LISTS, BUSY_ITERS)
      const controller = new AbortController()
      const search = rejection(idx.search(unitVec(0, BUSY_DIM), 1, { signal: controller.signal }))
      controller.abort()
      t.is((await search)?.name, 'AbortError', 'the queued search rejects with an AbortError')
      await build
      const again = await rejection(
        idx.search(unitVec(0, BUSY_DIM), 1, { signal: controller.signal })
      )
      t.is(again?.name, 'AbortError', 'an already aborted signal rejects a new call')
    } finally {
      await idx.dispose()
    }
  }
)

test('IdMapIndex abort: a running build rejects at once but still finishes', async (t) => {
  const idx = await busyIndex()
  const controller = createController()
  const build = rejection(idx.buildIvf(BUSY_LISTS, BUSY_ITERS, { signal: controller.signal }))
  // Waits for the native build, which keeps running after the abort.
  let afterDone = false
  const after = idx.searchIvf(randomBatch(1, BUSY_DIM, 9).vectors, 3, 8).then((hits) => {
    afterDone = true
    return hits
  })
  holdJsThread(20)
  controller.abort()
  const error = await build
  t.is(error && error.name, 'AbortError', 'the build rejects with an AbortError')
  t.absent(afterDone, 'before the native build finishes')
  const hits = await after
  t.is(hits.k, 3, 'the build took effect: a search queued after it uses the IVF state')
  await idx.dispose()
})

test(
  'IdMapIndex abort: results that finish after an abort are freed',
  { skip: IS_MOBILE },
  async (t) => {
    const frees = recordFrees(t)
    const file = tmpPath('id-map-index-abort-load')
    const idx = await filledIndex()
    try {
      await idx.write(file)

      const filterController = createController()
      const filter = rejection(
        idx.prepareFilter(new BigUint64Array([1n]), { signal: filterController.signal })
      )
      holdJsThread(50)
      filterController.abort()
      t.is((await filter)?.name, 'AbortError', 'prepareFilter rejects')
      await idx.search(unitVec(0), 1)
      t.alike(frees, ['filter'], 'and the filter it built is freed')

      frees.length = 0
      const loadController = createController()
      const loaded = rejection(IdMapIndex.load(file, { signal: loadController.signal }))
      holdJsThread(50)
      loadController.abort()
      t.is((await loaded)?.name, 'AbortError', 'load rejects')
      for (let i = 0; i < 100 && frees.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      t.alike(frees, ['index'], 'and the index it loaded is freed')
    } finally {
      await idx.dispose()
      removeFile(file)
    }
  }
)

test('IdMapIndex abort: a call that finishes first leaves the signal clean', async (t) => {
  const idx = await filledIndex()
  const controller = createController()
  const { signal } = controller
  t.is((await idx.search(unitVec(2), 1, { signal })).ids[0], 3n, 'the search resolves')
  t.is(await idx.contains(3n, { signal }), true, 'contains resolves')
  t.is(signal.listenerCount, 0, 'no abort listener is left on the signal')
  controller.abort()
  t.is((await idx.search(unitVec(2), 1)).ids[0], 3n, 'a later abort changes nothing')
  await idx.dispose()
})
