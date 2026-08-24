'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const MODULE_PATHS = [
  path.join(PACKAGE_ROOT, 'idMapIndex.js'),
  path.join(PACKAGE_ROOT, 'binding.js'),
  path.join(PACKAGE_ROOT, 'index.js'),
  path.join(PACKAGE_ROOT, 'addon.js')
]
const TARGET_ARCH = os.arch()
const IS_MOBILE = os.platform() === 'ios' || os.platform() === 'android'
const SUPPORTS_TURBOVEC = TARGET_ARCH === 's390x' || TARGET_ARCH.includes('64')

const IdMapIndex = require('@qvac/embed-llamacpp/idMapIndex')

const DIM = 16
const TURBOVEC_DIM = 128
const N = 10
const UINT64_MAX = (1n << 64n) - 1n

function unitVec(i) {
  const vector = new Float32Array(DIM)
  vector[i] = 1
  return vector
}

let tmpCounter = 0
function tmpPath(name) {
  const pid = os.pid ? os.pid() : 0
  tmpCounter += 1
  return path.join(os.tmpdir(), `${name}-${pid}-${Date.now()}-${tmpCounter}.tvim`)
}

function tmpDeltaPath(name) {
  return tmpPath(name).replace(/\.tvim$/, '.tvid')
}

function removeDeltaArtifacts(delta) {
  for (const artifact of [delta, `${delta}.lock`]) {
    if (fs.existsSync(artifact)) fs.unlinkSync(artifact)
  }
}

function expectThrows(t, fn, message) {
  try {
    fn()
    t.fail(message)
    return null
  } catch (error) {
    t.pass(`${message}: ${error.message || error.code}`)
    return error
  }
}

function expectDisposedFilter(t, filter, message) {
  const error = expectThrows(t, () => filter.search(new Float32Array([1, 0]), 1), message)
  t.is(
    error && error.message,
    'IdMapIndexFilter has been disposed',
    `${message} releases the filter`
  )
}

function findCacheKey(modulePath) {
  return Object.keys(require.cache).find((key) => require.cache[key].filename === modulePath)
}

function evictFromCache(modulePath) {
  const key = findCacheKey(modulePath)
  if (key !== undefined) delete require.cache[key]
}

function preserveCacheEntries(modulePaths) {
  const entries = []
  for (const modulePath of modulePaths) {
    const key = findCacheKey(modulePath)
    if (key !== undefined) entries.push([key, require.cache[key]])
  }
  return entries
}

function restoreCacheEntries(modulePaths, entries) {
  for (const modulePath of modulePaths) evictFromCache(modulePath)
  for (const [key, module] of entries) require.cache[key] = module
}

function assertTvimHeader(t, file, version, bitWidth, storageKind = null) {
  const bytes = fs.readFileSync(file)
  t.is(bytes[0], 0x54, 'tvim magic T')
  t.is(bytes[1], 0x56, 'tvim magic V')
  t.is(bytes[2], 0x50, 'tvim magic P')
  t.is(bytes[3], 0x49, 'tvim magic I')
  t.is(bytes[4], version, `tvim version ${version}`)
  t.is(bytes[5], bitWidth, 'tvim bit width')
  if (storageKind !== null) t.is(bytes[6], storageKind, 'tvim storage kind')
}

function assertTvidHeader(t, file) {
  const bytes = fs.readFileSync(file)
  t.is(bytes[0], 0x54, 'tvid magic T')
  t.is(bytes[1], 0x56, 'tvid magic V')
  t.is(bytes[2], 0x44, 'tvid magic D')
  t.is(bytes[3], 0x4c, 'tvid magic L')
  t.is(bytes[4], 4, 'tvid version 4')
}

function runRoundTrip(t, bitWidth) {
  const idx = new IdMapIndex({ dim: DIM, bitWidth })
  const vectors = new Float32Array(N * DIM)
  const ids = new BigUint64Array(N)

  for (let i = 0; i < N; i++) {
    vectors.set(unitVec(i), i * DIM)
    ids[i] = BigInt(i) + (1n << 40n) + (1n << 62n)
  }

  idx.addWithIds(vectors, ids)
  t.is(idx.length, N, `all vectors inserted (${bitWidth})`)
  t.ok(idx.contains(ids[3]), `contains a known id (${bitWidth})`)
  t.absent(idx.contains(999n), `absent id missing (${bitWidth})`)

  for (let i = 0; i < N; i++) {
    const out = idx.search(unitVec(i), 1)
    t.is(out.m, 1)
    t.is(out.k, 1)
    t.is(out.ids[0], ids[i], `query=${i} retrieves itself (${bitWidth})`)
    t.ok(Math.abs(out.scores[0] - 1) < 1e-5, `score is approximately one (${bitWidth})`)
  }

  const padded = idx.search(unitVec(0), N + 4)
  for (let i = N; i < N + 4; i++) {
    t.is(padded.ids[i], UINT64_MAX, `sentinel id at tail slot ${i} (${bitWidth})`)
    t.ok(padded.scores[i] < -3e38, `sentinel score at tail slot ${i} (${bitWidth})`)
  }

  expectThrows(
    t,
    () => idx.addWithIds(unitVec(0), new BigUint64Array([ids[0]])),
    `duplicate add should throw (${bitWidth})`
  )
  t.is(idx.length, N, `length unchanged after rejected duplicate (${bitWidth})`)

  t.is(idx.remove(ids[2]), true, `remove returns true for existing id (${bitWidth})`)
  t.is(idx.remove(ids[2]), false, `remove returns false for missing id (${bitWidth})`)
  t.absent(idx.contains(ids[2]), `removed id is absent (${bitWidth})`)
  idx.compact()
  idx.prepare()

  const file = tmpPath(`id-map-index-roundtrip-${bitWidth}`)
  try {
    idx.write(file)
    assertTvimHeader(t, file, 2, bitWidth)
    idx.dispose()

    const loaded = IdMapIndex.load(file)
    t.is(loaded.dim, DIM, `dim restored (${bitWidth})`)
    t.is(loaded.bitWidth, bitWidth, `bitWidth restored (${bitWidth})`)
    t.is(loaded.length, N - 1, `length restored (${bitWidth})`)
    t.absent(loaded.contains(ids[2]), `deletion persisted (${bitWidth})`)
    t.is(loaded.search(unitVec(0), 1).ids[0], ids[0], `search works after reload (${bitWidth})`)
    loaded.dispose()
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
}

function normalizedPatternVec(row) {
  const vector = new Float32Array(TURBOVEC_DIM)
  let norm = 0
  for (let col = 0; col < TURBOVEC_DIM; col++) {
    const value = Math.sin((row + 1) * (col + 3)) + Math.cos((row + 7) * (col + 1))
    vector[col] = value
    norm += value * value
  }
  norm = Math.sqrt(norm) || 1
  for (let col = 0; col < TURBOVEC_DIM; col++) vector[col] /= norm
  return vector
}

function runTurboVecRoundTrip(t, storage, bitWidth, storageKind) {
  const idx = new IdMapIndex({ dim: TURBOVEC_DIM, storage })
  const localN = 6
  const vectors = new Float32Array(localN * TURBOVEC_DIM)
  const ids = new BigUint64Array(localN)
  for (let i = 0; i < localN; i++) {
    vectors.set(normalizedPatternVec(i), i * TURBOVEC_DIM)
    ids[i] = 7000n + BigInt(i)
  }

  const delta = tmpDeltaPath(`id-map-index-${storage}-delta`)
  const file = tmpPath(`id-map-index-${storage}`)
  let loaded = null
  try {
    t.is(idx.bitWidth, bitWidth, `${storage} bitWidth getter`)
    idx.addWithIds(vectors, ids)
    for (let i = 0; i < localN; i++) {
      const query = vectors.subarray(i * TURBOVEC_DIM, (i + 1) * TURBOVEC_DIM)
      t.is(idx.search(query, 1).ids[0], ids[i], `${storage} query=${i} retrieves itself`)
    }

    const query = vectors.subarray(0, TURBOVEC_DIM)
    t.is(
      idx.searchFiltered(query, 1, new BigUint64Array([ids[0]])).ids[0],
      ids[0],
      `${storage} filtered search works`
    )
    idx.buildIvf(4, 0)
    t.is(idx.searchIvf(query, 1, 4).ids[0], ids[0], `${storage} IVF search works`)
    idx.write(file)
    const addLoggedError = expectThrows(
      t,
      () => idx.addLogged(query, new BigUint64Array([9999n]), delta),
      `${storage} addLogged should be rejected`
    )
    if (addLoggedError !== null) {
      t.is(addLoggedError.message, 'InvalidArgument', `${storage} addLogged error category`)
    }
    const removeLoggedError = expectThrows(
      t,
      () => idx.removeLogged(ids[0], delta),
      `${storage} removeLogged should be rejected`
    )
    if (removeLoggedError !== null) {
      t.is(removeLoggedError.message, 'InvalidArgument', `${storage} removeLogged error category`)
    }
    assertTvimHeader(t, file, 3, bitWidth, storageKind)
    expectThrows(t, () => IdMapIndex.loadMmap(file), `${storage} mmap load should be rejected`)
    loaded = IdMapIndex.load(file)
    t.is(loaded.search(query, 1).ids[0], ids[0], `${storage} reload search works`)
  } finally {
    if (loaded !== null) loaded.dispose()
    idx.dispose()
    if (fs.existsSync(file)) fs.unlinkSync(file)
    removeDeltaArtifacts(delta)
  }
}

test('IdMapIndex sub-export does not boot the BERT runtime', { skip: IS_MOBILE }, (t) => {
  const cachedEntries = preserveCacheEntries(MODULE_PATHS)
  try {
    for (const modulePath of MODULE_PATHS) evictFromCache(modulePath)
    const IsolatedIdMapIndex = require(MODULE_PATHS[0])
    const idx = new IsolatedIdMapIndex({ dim: DIM })
    t.is(idx.dim, DIM, 'dim getter')
    t.is(idx.bitWidth, 8, 'default bitWidth getter')
    t.is(idx.length, 0, 'starts empty')
    idx.dispose()
    t.ok(findCacheKey(MODULE_PATHS[0]), 'sub-export module loaded')
    t.ok(findCacheKey(MODULE_PATHS[1]), 'native binding loaded')
    t.absent(findCacheKey(MODULE_PATHS[2]), 'GGMLBert entry was not loaded')
    t.absent(findCacheKey(MODULE_PATHS[3]), 'BertInterface plumbing was not loaded')
  } finally {
    restoreCacheEntries(MODULE_PATHS, cachedEntries)
  }
})

test(
  'IdMapIndex root export resolves the class without loading the native binding',
  { skip: IS_MOBILE },
  (t) => {
    const cachedEntries = preserveCacheEntries(MODULE_PATHS)
    try {
      for (const modulePath of MODULE_PATHS) evictFromCache(modulePath)
      const rootModule = require(MODULE_PATHS[2])
      t.absent(findCacheKey(MODULE_PATHS[0]), 'IdMapIndex module starts unloaded')
      t.absent(findCacheKey(MODULE_PATHS[1]), 'native binding starts unloaded')

      const RootIdMapIndex = rootModule.IdMapIndex
      t.ok(findCacheKey(MODULE_PATHS[0]), 'accessing the root export loads the class module')
      t.absent(
        findCacheKey(MODULE_PATHS[1]),
        'accessing the class does not load the native binding'
      )
      t.is(RootIdMapIndex, require(MODULE_PATHS[0]), 'root getter returns the direct constructor')
    } finally {
      restoreCacheEntries(MODULE_PATHS, cachedEntries)
    }
  }
)

for (const bitWidth of [4, 8, 32]) {
  test(`IdMapIndex: ${bitWidth}-bit add + search + remove + persistence round-trip`, (t) => {
    runRoundTrip(t, bitWidth)
  })
}

test('IdMapIndex: TurboVec q4 add + search + persistence round-trip', (t) => {
  if (!SUPPORTS_TURBOVEC) {
    expectThrows(
      t,
      () => new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q4' }),
      'TurboVec q4 requires a 64-bit target'
    )
    return
  }
  runTurboVecRoundTrip(t, 'turbovec-q4', 4, 4)
})

test('IdMapIndex: TurboVec q2 add + search + persistence round-trip', (t) => {
  if (!SUPPORTS_TURBOVEC) {
    expectThrows(
      t,
      () => new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q2' }),
      'TurboVec q2 requires a 64-bit target'
    )
    return
  }
  runTurboVecRoundTrip(t, 'turbovec-q2', 2, 5)
})

test('IdMapIndex: validates production bit widths and TurboVec dimensions', (t) => {
  expectThrows(
    t,
    () => new IdMapIndex({ dim: DIM, bitWidth: 16 }),
    'bitWidth 16 should be rejected'
  )
  expectThrows(
    t,
    () => new IdMapIndex({ dim: DIM, storage: 'turbovec-q2', bitWidth: 4 }),
    'mismatched storage and bitWidth should be rejected'
  )
  expectThrows(
    t,
    () => new IdMapIndex({ dim: DIM, storage: 'unknown' }),
    'unknown storage rejected'
  )
  expectThrows(
    t,
    () => new IdMapIndex({ dim: 10, storage: 'turbovec-q4' }),
    'TurboVec dimensions must be divisible by 8'
  )
  if (SUPPORTS_TURBOVEC) {
    for (const storage of ['turbovec-q2', 'turbovec-q4']) {
      const max = new IdMapIndex({ dim: 1024, storage })
      const vector = new Float32Array(1024)
      vector[0] = 1
      max.addWithIds(vector, new BigUint64Array([1024n]))
      t.is(max.search(vector, 1).ids[0], 1024n, `${storage} searches at maximum dimension`)
      max.dispose()
    }
  }
  expectThrows(
    t,
    () => new IdMapIndex({ dim: 1032, storage: 'turbovec-q2' }),
    'TurboVec dimensions must not exceed 1024'
  )
  if (SUPPORTS_TURBOVEC) {
    const q2 = new IdMapIndex({ dim: TURBOVEC_DIM, bitWidth: 2 })
    t.is(q2.bitWidth, 2, 'bitWidth 2 selects TurboVec q2')
    q2.dispose()
  }
  const defaulted = new IdMapIndex({ dim: DIM, bitWidth: undefined })
  t.is(defaulted.bitWidth, 8, 'undefined bitWidth uses default')
  defaulted.dispose()
})

test('IdMapIndex: ESM wrappers expose named exports', async (t) => {
  const idMapModule = await import('@qvac/embed-llamacpp/idMapIndex')
  t.is(idMapModule.default, idMapModule.IdMapIndex, 'subpath default and named class match')
  t.ok(idMapModule.IdMapIndexFilter, 'subpath named filter export exists')
  const rootModule = await import('@qvac/embed-llamacpp')
  t.is(rootModule.default, rootModule.GGMLBert, 'root default and named GGMLBert match')
  t.is(rootModule.IdMapIndex, idMapModule.IdMapIndex, 'root and subpath constructors match')
  t.is(
    rootModule.IdMapIndexFilter,
    idMapModule.IdMapIndexFilter,
    'root and subpath filter constructors match'
  )
  const idx = new rootModule.IdMapIndex({ dim: DIM })
  t.ok(idx instanceof idMapModule.IdMapIndex, 'root and subpath use the same class')
  idx.dispose()
})

test('IdMapIndex: root constructor preserves subclass semantics', (t) => {
  const rootModule = require('@qvac/embed-llamacpp')
  const DirectIdMapIndex = require('@qvac/embed-llamacpp/idMapIndex')
  const RootIdMapIndex = rootModule.IdMapIndex

  class ExtendedIdMapIndex extends RootIdMapIndex {
    extendedMethod() {
      return 'extended'
    }
  }

  const idx = new ExtendedIdMapIndex({ dim: DIM })
  t.is(RootIdMapIndex, DirectIdMapIndex, 'CommonJS root and subpath constructors match')
  t.is(RootIdMapIndex.prototype, DirectIdMapIndex.prototype, 'constructor prototypes match')
  t.is(Object.getPrototypeOf(idx), ExtendedIdMapIndex.prototype, 'subclass prototype is preserved')
  t.is(idx.extendedMethod(), 'extended', 'subclass methods remain available')
  idx.dispose()
})

test('IdMapIndex: CommonJS TypeScript default import works without interop', (t) => {
  const consumer = require('../types/consumer-cjs.test.js')
  const idMapModule = require('@qvac/embed-llamacpp/idMapIndex')
  const rootModule = require('@qvac/embed-llamacpp')

  t.is(
    consumer.getRootDefaultImport(),
    rootModule,
    'package root default import resolves to GGMLBert'
  )
  t.is(consumer.getDefaultImport(), IdMapIndex, 'CommonJS default import resolves to the class')
  t.is(idMapModule.IdMapIndex, IdMapIndex, 'named class export remains aligned')
  t.is(
    idMapModule.IdMapIndexFilter,
    IdMapIndex.IdMapIndexFilter,
    'named filter export remains aligned'
  )
})

test('IdMapIndex: rejects numeric arguments outside int32 range', (t) => {
  const tooLarge = 0x80000000
  expectThrows(t, () => new IdMapIndex({ dim: tooLarge }), 'oversized dim should be rejected')
  const idx = new IdMapIndex({ dim: 2 })
  let filter = null
  try {
    idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([1n]))
    filter = idx.prepareFilter(new BigUint64Array([1n]))
    expectThrows(t, () => idx.search(new Float32Array([1, 0]), tooLarge), 'oversized k rejected')
    expectThrows(
      t,
      () => idx.searchFiltered(new Float32Array([1, 0]), tooLarge, new BigUint64Array([1n])),
      'oversized filtered k rejected'
    )
    expectThrows(
      t,
      () => filter.search(new Float32Array([1, 0]), tooLarge),
      'oversized prepared-filter k rejected'
    )
    expectThrows(t, () => idx.buildIvf(tooLarge, 0), 'oversized nLists rejected')
    expectThrows(
      t,
      () => idx.searchIvf(new Float32Array([1, 0]), 1, tooLarge),
      'oversized nProbe rejected'
    )
  } finally {
    if (filter !== null) filter.dispose()
    idx.dispose()
  }
})

test('IdMapIndex: load APIs throw synchronously for invalid input', (t) => {
  expectThrows(t, () => IdMapIndex.load(''), 'load invalid path throws')
  expectThrows(t, () => IdMapIndex.loadMmap(''), 'loadMmap invalid path throws')
  expectThrows(t, () => IdMapIndex.loadWithDelta('', ''), 'loadWithDelta invalid paths throw')
})

test('IdMapIndex: rejects mismatched empty-id add', (t) => {
  const idx = new IdMapIndex({ dim: 2 })
  expectThrows(
    t,
    () => idx.addWithIds(new Float32Array([1, 2]), new BigUint64Array()),
    'vectors with empty ids should be rejected'
  )
  t.is(idx.length, 0, 'failed add does not mutate')
  idx.addWithIds(new Float32Array(), new BigUint64Array())
  t.is(idx.length, 0, 'empty add remains a no-op')
  idx.dispose()
})

test('IdMapIndex: BigInt id range edge cases', (t) => {
  const idx = new IdMapIndex({ dim: 2 })
  const edge = (1n << 63n) + 7n
  idx.addWithIds(new Float32Array([0.5, 0.5]), new BigUint64Array([edge]))
  t.ok(idx.contains(edge), 'high-bit id round-trips')
  t.is(idx.search(new Float32Array([0.5, 0.5]), 1).ids[0], edge, 'high-bit id surfaces')
  expectThrows(
    t,
    () => idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([UINT64_MAX])),
    'UINT64_MAX is reserved for padding'
  )
  idx.dispose()
})

test('IdMapIndex: filtered and prepared-filter searches restrict allowed ids', (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  let filter = null
  try {
    idx.addWithIds(new Float32Array([1, 0, 0, 1, 0.5, 0.5]), new BigUint64Array([11n, 22n, 33n]))
    const out = idx.searchFiltered(new Float32Array([1, 0]), 2, new BigUint64Array([22n, 33n, 44n]))
    t.is(out.ids[0], 33n, 'best allowed id wins')
    t.is(out.ids[1], 22n, 'lower-scoring allowed id follows')

    filter = idx.prepareFilter(new BigUint64Array([22n, 33n]))
    t.is(filter.search(new Float32Array([0, 1]), 1).ids[0], 22n, 'prepared filter is reusable')
    idx.addWithIds(new Float32Array([0.25, 0.75]), new BigUint64Array([44n]))
    expectDisposedFilter(t, filter, 'mutation invalidates prepared filter')
  } finally {
    if (filter !== null) filter.dispose()
    idx.dispose()
  }
})

test('IdMapIndex: every mutation path disposes prepared filters when required', (t) => {
  const snapshot = tmpPath('id-map-index-filter-invalidation-snapshot')
  const delta = tmpDeltaPath('id-map-index-filter-invalidation-delta')
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  let filter = null
  try {
    idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))

    filter = idx.prepareFilter(new BigUint64Array([11n]))
    t.is(idx.remove(999n), false, 'missing plain remove is a no-op')
    t.is(filter.search(new Float32Array([1, 0]), 1).ids[0], 11n, 'no-op remove preserves filter')
    t.is(idx.remove(22n), true, 'plain remove mutates the index')
    expectDisposedFilter(t, filter, 'successful remove invalidates prepared filter')

    filter = idx.prepareFilter(new BigUint64Array([11n]))
    idx.compact()
    expectDisposedFilter(t, filter, 'compact invalidates prepared filter')

    idx.write(snapshot)
    filter = idx.prepareFilter(new BigUint64Array([11n]))
    idx.addLogged(new Float32Array([0.5, 0.5]), new BigUint64Array([33n]), delta)
    expectDisposedFilter(t, filter, 'logged add invalidates prepared filter')

    filter = idx.prepareFilter(new BigUint64Array([11n]))
    t.is(idx.removeLogged(999n, delta), false, 'missing logged remove returns false')
    expectDisposedFilter(t, filter, 'logged remove invalidates prepared filter')

    filter = idx.prepareFilter(new BigUint64Array([11n]))
    idx.compactDelta(snapshot, delta)
    expectDisposedFilter(t, filter, 'delta compaction invalidates prepared filter')
  } finally {
    if (filter !== null) filter.dispose()
    idx.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: IVF build and search lifecycle', (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  idx.addWithIds(
    new Float32Array([1, 0, 0, 1, 0.5, 0.5, -1, 0]),
    new BigUint64Array([11n, 22n, 33n, 44n])
  )
  expectThrows(
    t,
    () => idx.searchIvf(new Float32Array([1, 0]), 1, 1),
    'IVF search before build should throw'
  )
  idx.buildIvf(4, 0)
  t.is(idx.searchIvf(new Float32Array([1, 0]), 2, 4).ids[0], 11n, 'IVF nearest id')
  idx.addWithIds(new Float32Array([0.25, 0.75]), new BigUint64Array([55n]))
  expectThrows(t, () => idx.searchIvf(new Float32Array([1, 0]), 1, 4), 'mutation invalidates IVF')
  idx.dispose()
})

test('IdMapIndex: v4 delta log replay and compaction', (t) => {
  const snapshot = tmpPath('id-map-index-delta-snapshot')
  const delta = tmpDeltaPath('id-map-index-delta-log')
  let idx = null
  let replayed = null
  let compacted = null
  try {
    idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
    idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))
    idx.write(snapshot)
    idx.addLogged(new Float32Array([0.5, 0.5]), new BigUint64Array([33n]), delta)
    t.is(idx.removeLogged(11n, delta), true, 'logged remove returns true for existing id')
    t.is(idx.removeLogged(44n, delta), false, 'logged remove returns false for absent id')
    assertTvidHeader(t, delta)

    replayed = IdMapIndex.loadWithDelta(snapshot, delta)
    t.absent(replayed.contains(11n), 'delta replay applies remove')
    t.ok(replayed.contains(22n), 'delta replay keeps snapshot id')
    t.ok(replayed.contains(33n), 'delta replay applies add')
    expectThrows(
      t,
      () => replayed.addWithIds(new Float32Array(), new BigUint64Array()),
      'delta-bound handle rejects an empty plain add'
    )
    replayed.dispose()
    replayed = null

    idx.compactDelta(snapshot, delta)
    assertTvimHeader(t, snapshot, 2, 4)
    assertTvidHeader(t, delta)
    idx.dispose()
    idx = null
    compacted = IdMapIndex.loadWithDelta(snapshot, delta)
    t.absent(compacted.contains(11n), 'compacted snapshot excludes removed id')
    t.ok(compacted.contains(33n), 'compacted snapshot includes logged add')
  } finally {
    if (idx !== null) idx.dispose()
    if (replayed !== null) replayed.dispose()
    if (compacted !== null) compacted.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: stale delta writers retain catch-up on a missing remove', (t) => {
  const snapshot = tmpPath('id-map-index-stale-writer-snapshot')
  const delta = tmpDeltaPath('id-map-index-stale-writer-log')
  let first = null
  let stale = null
  try {
    const seed = new IdMapIndex({ dim: 2, bitWidth: 4 })
    seed.addWithIds(new Float32Array([1, 0]), new BigUint64Array([11n]))
    seed.write(snapshot)
    seed.dispose()

    first = IdMapIndex.loadWithDelta(snapshot, delta)
    stale = IdMapIndex.loadWithDelta(snapshot, delta)
    first.addLogged(new Float32Array([0, 1]), new BigUint64Array([22n]), delta)
    t.is(stale.removeLogged(999n, delta), false, 'missing remove returns false')
    t.ok(stale.contains(22n), 'stale writer retains catch-up before missing remove')
  } finally {
    if (first !== null) first.dispose()
    if (stale !== null) stale.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: missing and corrupt delta logs', (t) => {
  const snapshot = tmpPath('id-map-index-delta-errors')
  const delta = tmpDeltaPath('id-map-index-delta-errors')
  let idx = null
  let loaded = null
  try {
    idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
    idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([11n]))
    idx.write(snapshot)
    loaded = IdMapIndex.loadWithDelta(snapshot, delta)
    t.ok(loaded.contains(11n), 'missing delta log replays as empty')
    loaded.addLogged(new Float32Array([0, 1]), new BigUint64Array([22n]), delta)
    loaded.addLogged(new Float32Array([1, 0]), new BigUint64Array([23n]), delta)
    loaded.dispose()
    loaded = null
    const corrupt = fs.readFileSync(delta)
    corrupt[64] ^= 1
    fs.writeFileSync(delta, corrupt)
    expectThrows(
      t,
      () => IdMapIndex.loadWithDelta(snapshot, delta),
      'corrupt delta log should throw'
    )
  } finally {
    if (idx !== null) idx.dispose()
    if (loaded !== null) loaded.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: rejects non-finite vectors and queries', (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 8 })
  expectThrows(
    t,
    () => idx.addWithIds(new Float32Array([1, Infinity]), new BigUint64Array([1n])),
    'non-finite vector should be rejected'
  )
  idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([1n]))
  expectThrows(
    t,
    () => idx.search(new Float32Array([NaN, 0]), 1),
    'non-finite query should be rejected'
  )
  idx.dispose()

  if (SUPPORTS_TURBOVEC) {
    for (const storage of ['turbovec-q2', 'turbovec-q4']) {
      const turbovec = new IdMapIndex({ dim: 8, storage })
      const valid = new Float32Array(8)
      valid[0] = 1
      expectThrows(
        t,
        () =>
          turbovec.addWithIds(
            new Float32Array([1e16, 0, 0, 0, 0, 0, 0, 0]),
            new BigUint64Array([1n])
          ),
        `${storage} rejects finite components at the magnitude limit`
      )
      turbovec.addWithIds(valid, new BigUint64Array([1n]))
      expectThrows(
        t,
        () => turbovec.search(new Float32Array([1e16, 0, 0, 0, 0, 0, 0, 0]), 1),
        `${storage} rejects finite query components at the magnitude limit`
      )
      turbovec.dispose()
    }
  }
})

test('IdMapIndex: mmap load is searchable and read-only', (t) => {
  const file = tmpPath('id-map-index-mmap')
  let mmap = null
  try {
    const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
    idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))
    idx.write(file)
    idx.dispose()
    mmap = IdMapIndex.loadMmap(file)
    t.is(mmap.search(new Float32Array([0, 1]), 1).ids[0], 22n, 'mmap search works')
    expectThrows(
      t,
      () => mmap.addWithIds(new Float32Array(), new BigUint64Array()),
      'mmap handle rejects an empty add'
    )
    expectThrows(
      t,
      () => mmap.addWithIds(new Float32Array([0.5, 0.5]), new BigUint64Array([33n])),
      'mmap add should be rejected'
    )
    expectThrows(t, () => mmap.remove(11n), 'mmap remove should be rejected')
  } finally {
    if (mmap !== null) mmap.dispose()
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})

test('IdMapIndex: dispose is deterministic and idempotent', (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  idx.dispose()
  idx.dispose()
  expectThrows(t, () => idx.contains(1n), 'disposed contains should throw')
})

test('IdMapIndex: corrupt persistence file load fails', (t) => {
  const file = tmpPath('id-map-index-corrupt')
  try {
    fs.writeFileSync(file, new Uint8Array(32))
    const error = expectThrows(t, () => IdMapIndex.load(file), 'corrupt tvim file should throw')
    if (error !== null) t.is(error.message, 'BadMagic', 'load preserves native error category')
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})
