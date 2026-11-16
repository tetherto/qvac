'use strict'

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

function filledIndex(options = { dim: DIM, bitWidth: 32 }) {
  const idx = new IdMapIndex(options)
  const { vectors, ids } = unitBatch()
  idx.addWithIds(vectors, ids)
  return idx
}

function busyIndex() {
  const idx = new IdMapIndex({ dim: BUSY_DIM, bitWidth: 32 })
  const { vectors, ids } = randomBatch(BUSY_ROWS, BUSY_DIM)
  idx.addWithIds(vectors, ids)
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

function sameResult(t, actual, expected, message) {
  t.is(actual.m, expected.m, `${message}: m`)
  t.is(actual.k, expected.k, `${message}: k`)
  t.alike(Array.from(actual.ids), Array.from(expected.ids), `${message}: ids`)
  t.alike(Array.from(actual.scores), Array.from(expected.scores), `${message}: scores`)
}

test('IdMapIndex async: searches resolve with the same results as the sync calls', async (t) => {
  const idx = filledIndex()
  const query = unitVec(3)
  sameResult(t, await idx.searchAsync(query, 3), idx.search(query, 3), 'searchAsync')

  const allowed = new BigUint64Array([2n, 4n, 6n])
  sameResult(
    t,
    await idx.searchFilteredAsync(query, 2, allowed),
    idx.searchFiltered(query, 2, allowed),
    'searchFilteredAsync'
  )

  const filter = await idx.prepareFilterAsync(allowed)
  t.ok(filter instanceof IdMapIndex.IdMapIndexFilter, 'prepareFilterAsync returns a filter')
  sameResult(t, await filter.searchAsync(query, 2), filter.search(query, 2), 'filter.searchAsync')
  filter.dispose()

  const twin = filledIndex()
  await idx.buildIvfAsync(4, 2)
  twin.buildIvf(4, 2)
  sameResult(
    t,
    await idx.searchIvfAsync(query, 3, 4),
    twin.searchIvf(query, 3, 4),
    'searchIvfAsync after buildIvfAsync'
  )

  await idx.prepareAsync()
  t.pass('prepareAsync resolves')
  twin.dispose()
  idx.dispose()
})

test('IdMapIndex async: mutations resolve like the sync calls', async (t) => {
  const idx = new IdMapIndex({ dim: DIM, bitWidth: 32 })
  const { vectors, ids } = unitBatch()
  t.is(await idx.addWithIdsAsync(vectors, ids), undefined, 'addWithIdsAsync resolves undefined')
  t.is(idx.length, N, 'the add landed')

  t.is(await idx.removeAsync(3n), true, 'removeAsync resolves true for a present id')
  t.is(await idx.removeAsync(3n), false, 'removeAsync resolves false for a missing id')
  t.absent(idx.contains(3n), 'the id is gone')

  await idx.compactAsync()
  t.is(idx.length, N - 1, 'compactAsync keeps the live entries')
  idx.dispose()
})

test('IdMapIndex async: write and load round-trip', async (t) => {
  const file = tmpPath('id-map-index-async')
  const idx = filledIndex()
  try {
    await idx.writeAsync(file)
    const loaded = await IdMapIndex.loadAsync(file)
    t.ok(loaded instanceof IdMapIndex, 'loadAsync resolves an IdMapIndex')
    t.is(loaded.length, N, 'loadAsync keeps every entry')
    t.is(loaded.dim, DIM, 'loadAsync keeps dim')
    t.is(loaded.bitWidth, 32, 'loadAsync keeps bitWidth')
    sameResult(t, await loaded.searchAsync(unitVec(5), 2), idx.search(unitVec(5), 2), 'search')
    loaded.dispose()

    const mapped = await IdMapIndex.loadMmapAsync(file)
    t.is(mapped.length, N, 'loadMmapAsync keeps every entry')
    t.is(
      (await rejection(mapped.addWithIdsAsync(unitVec(0), new BigUint64Array([99n])))) !== null,
      true,
      'an mmap index rejects async mutations'
    )
    mapped.dispose()

    class Sub extends IdMapIndex {}
    const sub = await Sub.loadAsync(file)
    t.ok(sub instanceof Sub, 'loadAsync on a subclass resolves that subclass')
    sub.dispose()
  } finally {
    idx.dispose()
    removeFile(file)
  }
})

test('IdMapIndex async: delta log mutations and compaction', async (t) => {
  const snapshot = tmpPath('id-map-index-async-delta')
  const delta = snapshot.replace(/\.tvim$/, '.tvid')
  const idx = filledIndex()
  try {
    await idx.writeAsync(snapshot)
    await idx.addLoggedAsync(unitVec(11), new BigUint64Array([100n]), delta)
    t.is(await idx.removeLoggedAsync(1n, delta), true, 'removeLoggedAsync resolves true')

    const replayed = await IdMapIndex.loadWithDeltaAsync(snapshot, delta)
    t.is(replayed.length, N, 'loadWithDeltaAsync replays the add and the remove')
    t.ok(replayed.contains(100n), 'the logged add replays')
    t.absent(replayed.contains(1n), 'the logged remove replays')

    await replayed.compactDeltaAsync(snapshot, delta)
    const compacted = await IdMapIndex.loadAsync(snapshot)
    t.is(compacted.length, N, 'compactDeltaAsync writes the replayed state')
    compacted.dispose()
    replayed.dispose()
  } finally {
    idx.dispose()
    removeFile(snapshot)
    removeFile(delta)
  }
})

test('IdMapIndex async: native errors reject with the sync error code', async (t) => {
  const idx = filledIndex()
  const duplicate = await rejection(idx.addWithIdsAsync(unitVec(0), new BigUint64Array([1n])))
  const syncDuplicate = syncError(() => idx.addWithIds(unitVec(0), new BigUint64Array([1n])))
  t.ok(duplicate, 'a duplicate id rejects')
  t.is(duplicate && duplicate.code, syncDuplicate && syncDuplicate.code, 'with the sync code')

  const ivf = await rejection(idx.searchIvfAsync(unitVec(0), 1, 1))
  const syncIvf = syncError(() => idx.searchIvf(unitVec(0), 1, 1))
  t.ok(ivf, 'IVF search before a build rejects')
  t.is(ivf && ivf.code, syncIvf && syncIvf.code, 'with the sync code')

  const missing = await rejection(IdMapIndex.loadAsync(tmpPath('id-map-index-async-missing')))
  t.ok(missing, 'loading a missing file rejects')
  idx.dispose()
})

test('IdMapIndex async: bad arguments reject instead of throwing', async (t) => {
  const idx = filledIndex()
  const calls = {
    searchAsync: () => idx.searchAsync([1, 2], 1),
    'searchAsync k': () => idx.searchAsync(unitVec(0), 0),
    addWithIdsAsync: () => idx.addWithIdsAsync(unitVec(0), new BigUint64Array(2)),
    buildIvfAsync: () => idx.buildIvfAsync(0),
    searchIvfAsync: () => idx.searchIvfAsync(unitVec(0), 1, 0),
    removeAsync: () => idx.removeAsync(1),
    writeAsync: () => idx.writeAsync(''),
    loadAsync: () => IdMapIndex.loadAsync('')
  }
  for (const [name, call] of Object.entries(calls)) {
    let promise = null
    t.execution(() => {
      promise = call()
    }, `${name} does not throw synchronously`)
    t.ok(await rejection(promise), `${name} rejects`)
  }
  t.is(idx.length, N, 'the index is untouched')
  idx.dispose()
})

test('IdMapIndex async: operations on one index run in call order', async (t) => {
  const idx = new IdMapIndex({ dim: DIM, bitWidth: 32 })
  const { vectors, ids } = unitBatch()
  const order = []
  const add = idx.addWithIdsAsync(vectors, ids).then(() => order.push('add'))
  const search = idx.searchAsync(unitVec(4), 1).then((result) => {
    order.push('search')
    return result
  })
  const remove = idx.removeAsync(5n).then((removed) => {
    order.push('remove')
    return removed
  })
  const after = idx.searchAsync(unitVec(4), 1)
  const [, found, removed, gone] = await Promise.all([add, search, remove, after])
  t.alike(order, ['add', 'search', 'remove'], 'promises settle in call order')
  t.is(found.ids[0], 5n, 'a search queued after an add sees it')
  t.is(removed, true, 'the remove ran after the add')
  t.not(gone.ids[0], 5n, 'a search queued after a remove does not see the id')
  idx.dispose()
})

test('IdMapIndex async: sync calls throw while async work is pending', async (t) => {
  const idx = filledIndex()
  const pending = idx.searchAsync(unitVec(0), 1)
  for (const [name, call] of Object.entries({
    search: () => idx.search(unitVec(0), 1),
    addWithIds: () => idx.addWithIds(unitVec(0), new BigUint64Array([99n])),
    length: () => idx.length,
    contains: () => idx.contains(1n),
    prepareFilter: () => idx.prepareFilter(new BigUint64Array([1n]))
  })) {
    const error = syncError(call)
    t.ok(error && /async operations in progress/.test(error.message), `${name} throws`)
  }
  t.is(idx.dim, DIM, 'dim still works')
  t.is(idx.bitWidth, 32, 'bitWidth still works')
  await pending
  t.is(idx.length, N, 'sync calls work again once the work has settled')
  idx.dispose()
})

test('IdMapIndex async: an IVF build leaves the JS thread free', async (t) => {
  const big = busyIndex()
  const small = filledIndex()
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 1)
  let buildDone = false
  try {
    const build = big.buildIvfAsync(BUSY_LISTS, BUSY_ITERS).then(() => {
      buildDone = true
    })
    const result = await small.searchAsync(unitVec(2), 1)
    t.is(result.ids[0], 3n, 'another index answers a search')
    t.absent(buildDone, 'before the build on the first index finishes')
    await build
    t.ok(ticks > 0, `timers kept firing during the build (${ticks} ticks)`)
    const hits = await big.searchIvfAsync(randomBatch(1, BUSY_DIM, 7).vectors, 5, 8)
    t.is(hits.k, 5, 'the built IVF state is searchable')
  } finally {
    clearInterval(timer)
    small.dispose()
    big.dispose()
  }
})

test('IdMapIndex async: dispose during a build', async (t) => {
  const idx = busyIndex()
  const build = idx.buildIvfAsync(BUSY_LISTS, BUSY_ITERS)
  // Handled right away: it rejects as soon as the build settles.
  const queued = rejection(idx.searchAsync(randomBatch(1, BUSY_DIM, 3).vectors, 1))
  idx.dispose()
  t.execution(() => idx.dispose(), 'dispose stays idempotent')

  await build
  t.pass('the running build still finishes')
  const error = await queued
  t.is(error && error.message, 'IdMapIndex has been disposed', 'a queued search rejects')
  await idx.disposeAsync()
  t.is(
    syncError(() => idx.length)?.message,
    'IdMapIndex has been disposed',
    'the index is disposed afterwards'
  )
  t.ok(await rejection(idx.searchAsync(randomBatch(1, BUSY_DIM).vectors, 1)), 'later calls reject')
})

test('IdMapIndex async: disposeAsync resolves after queued work', async (t) => {
  const idx = filledIndex()
  const search = idx.searchAsync(unitVec(1), 1)
  await idx.disposeAsync()
  t.is((await search).ids[0], 2n, 'the running search finished')
})

test('IdMapIndex async: filters and queued mutations', async (t) => {
  const idx = filledIndex()
  const filter = idx.prepareFilter(new BigUint64Array([1n, 2n]))
  const search = filter.searchAsync(unitVec(1), 1)
  filter.dispose()
  t.is((await search).ids[0], 2n, 'a filter disposed mid-search still answers that search')
  t.ok(await rejection(filter.searchAsync(unitVec(1), 1)), 'later filter searches reject')

  const second = idx.prepareFilter(new BigUint64Array([1n, 2n]))
  const add = idx.addWithIdsAsync(unitVec(5), new BigUint64Array([50n]))
  const stale = rejection(second.searchAsync(unitVec(1), 1))
  await add
  const error = await stale
  t.is(
    error && error.message,
    'IdMapIndexFilter has been disposed',
    'a filter search queued after a mutation rejects'
  )
  idx.dispose()
})

test('IdMapIndex async: TurboVec search matches sync', async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    t.pass('TurboVec needs a 64-bit target')
    return
  }
  const idx = new IdMapIndex({ dim: 128, storage: 'turbovec-q4' })
  const { vectors, ids } = randomBatch(64, 128, 11)
  await idx.addWithIdsAsync(vectors, ids)
  const query = randomBatch(2, 128, 12).vectors
  sameResult(t, await idx.searchAsync(query, 5), idx.search(query, 5), 'turbovec searchAsync')
  idx.dispose()
})

test('IdMapIndex async: native async calls refuse a busy index', { skip: IS_MOBILE }, async (t) => {
  const binding = require('../../binding')
  const handle = binding.idx_create({ dim: DIM, storage: 'f32' })
  const { vectors, ids } = unitBatch()
  binding.idx_add(handle, vectors, ids)
  const running = binding.idx_search_async(handle, unitVec(0), 1)
  for (const [name, call] of Object.entries({
    'a second job': () => binding.idx_search_async(handle, unitVec(0), 1),
    'a sync call': () => binding.idx_len(handle),
    dispose: () => binding.idx_dispose(handle)
  })) {
    const error = syncError(call)
    t.is(error && error.code, 'Busy', `${name} is refused`)
  }
  t.is((await running).ids[0], 1n, 'the running job finishes')
  t.is(binding.idx_len(handle), N, 'the index is idle again')
  binding.idx_dispose(handle)
})

test('IdMapIndex async: a sync mutation refused while busy keeps prepared filters', async (t) => {
  const idx = filledIndex()
  const filter = idx.prepareFilter(new BigUint64Array([1n, 2n]))
  const search = filter.searchAsync(unitVec(1), 1)
  for (const [name, call] of Object.entries({
    addWithIds: () => idx.addWithIds(unitVec(0), new BigUint64Array([99n])),
    compact: () => idx.compact()
  })) {
    t.ok(syncError(call), `${name} throws while busy`)
  }
  t.is((await search).ids[0], 2n, 'the queued filter search still runs')
  t.is(filter.search(unitVec(0), 1).ids[0], 1n, 'and the filter is still usable')
  idx.dispose()
})

test('IdMapIndex async: prepareFilterAsync rejects when the index is disposed meanwhile', async (t) => {
  const idx = filledIndex()
  const pending = rejection(idx.prepareFilterAsync(new BigUint64Array([1n, 2n])))
  idx.dispose()
  const error = await pending
  t.is(error && error.message, 'IdMapIndex has been disposed', 'the filter is not handed out')
  await idx.disposeAsync()
})

test('IdMapIndex async: inputs are copied when the call is made', async (t) => {
  const idx = new IdMapIndex({ dim: DIM, bitWidth: 32 })
  const { vectors, ids } = unitBatch()
  const add = idx.addWithIdsAsync(vectors, ids)
  ids.fill(0xffffffffffffffffn)
  vectors.fill(0)
  await add
  t.ok(idx.contains(1n) && idx.contains(BigInt(N)), 'the add used the ids it was called with')
  t.absent(idx.contains(0xffffffffffffffffn), 'the reserved id was not added')

  const query = unitVec(6)
  const expected = idx.search(query, 1)
  const search = idx.searchAsync(query, 1)
  query.buffer.transfer()
  t.is(query.length, 0, 'the query buffer was detached')
  sameResult(t, await search, expected, 'a search whose query was detached')

  const allowed = new BigUint64Array([7n])
  const filtered = idx.searchFilteredAsync(unitVec(6), 1, allowed)
  allowed[0] = 3n
  t.is((await filtered).ids[0], 7n, 'the allow-list was copied')
  idx.dispose()
})

test('IdMapIndex async: two builds do not hold up a search on a third index', async (t) => {
  const first = busyIndex()
  const second = busyIndex()
  const small = filledIndex()
  let builds = 0
  try {
    const done = Promise.all([
      first.buildIvfAsync(BUSY_LISTS, BUSY_ITERS).then(() => builds++),
      second.buildIvfAsync(BUSY_LISTS, BUSY_ITERS).then(() => builds++)
    ])
    const result = await small.searchAsync(unitVec(2), 1)
    t.is(result.ids[0], 3n, 'the search answers')
    t.is(builds, 0, 'before either build finishes')
    await done
  } finally {
    small.dispose()
    second.dispose()
    first.dispose()
  }
})
