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
const TURBOVEC_DIM = 128
// The addon calibrates a fresh TurboVec index from its first add when that add
// has at least this many rows (VectorIndex::AUTO_CALIBRATE_MIN_ROWS).
const AUTO_CALIBRATE_MIN_ROWS = 1000
// Any fixed value works; it only has to be the same on every run.
const CALIBRATION_SEED = 0x5eed
const N = 10
const UINT64_MAX = (1n << 64n) - 1n

// Native errors are inference-addon-cpp StatusErrors: their `code` names the
// addon and the error category.
function errorCode(category) {
  return `[ TurboVec :: ${category} ]`
}

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

async function expectRejects(t, fn, message) {
  try {
    await fn()
    t.fail(message)
    return null
  } catch (error) {
    t.pass(`${message}: ${error.message || error.code}`)
    return error
  }
}

async function expectDisposedFilter(t, filter, message) {
  const error = await expectRejects(t, () => filter.search(new Float32Array([1, 0]), 1), message)
  t.is(
    error && error.message,
    'IdMapIndexFilter has been disposed',
    `${message} releases the filter`
  )
}

function assertTvimHeader(t, file, version, bitWidth) {
  const bytes = fs.readFileSync(file)
  t.is(bytes[0], 0x54, 'tvim magic T')
  t.is(bytes[1], 0x56, 'tvim magic V')
  t.is(bytes[2], 0x50, 'tvim magic P')
  t.is(bytes[3], 0x49, 'tvim magic I')
  t.is(bytes[4], version, `tvim version ${version}`)
  t.is(bytes[5], bitWidth, 'tvim bit width')
}

// TurboVec snapshots use upstream turbovec's v8 container: magic "TV8\0",
// revision, bit width, then kind 1 for an id-mapped index.
function assertTv8Header(t, file, bitWidth) {
  const bytes = fs.readFileSync(file)
  t.is(bytes[0], 0x54, 'tv8 magic T')
  t.is(bytes[1], 0x56, 'tv8 magic V')
  t.is(bytes[2], 0x38, 'tv8 magic 8')
  t.is(bytes[3], 0x00, 'tv8 magic NUL')
  t.is(bytes[4], 1, 'tv8 revision')
  t.is(bytes[5], bitWidth, 'tv8 bit width')
  t.is(bytes[6], 1, 'tv8 id-mapped kind')
}

function assertTvidHeader(t, file) {
  const bytes = fs.readFileSync(file)
  t.is(bytes[0], 0x54, 'tvid magic T')
  t.is(bytes[1], 0x56, 'tvid magic V')
  t.is(bytes[2], 0x44, 'tvid magic D')
  t.is(bytes[3], 0x4c, 'tvid magic L')
  t.is(bytes[4], 4, 'tvid version 4')
}

async function runRoundTrip(t, bitWidth) {
  const idx = new IdMapIndex({ dim: DIM, bitWidth })
  const vectors = new Float32Array(N * DIM)
  const ids = new BigUint64Array(N)

  for (let i = 0; i < N; i++) {
    vectors.set(unitVec(i), i * DIM)
    ids[i] = BigInt(i) + (1n << 40n) + (1n << 62n)
  }

  await idx.addWithIds(vectors, ids)
  t.is(idx.length, N, `all vectors inserted (${bitWidth})`)
  t.ok(await idx.contains(ids[3]), `contains a known id (${bitWidth})`)
  t.absent(await idx.contains(999n), `absent id missing (${bitWidth})`)

  for (let i = 0; i < N; i++) {
    const out = await idx.search(unitVec(i), 1)
    t.is(out.m, 1)
    t.is(out.k, 1)
    t.is(out.ids[0], ids[i], `query=${i} retrieves itself (${bitWidth})`)
    t.ok(Math.abs(out.scores[0] - 1) < 1e-5, `score is approximately one (${bitWidth})`)
  }

  const padded = await idx.search(unitVec(0), N + 4)
  for (let i = N; i < N + 4; i++) {
    t.is(padded.ids[i], UINT64_MAX, `sentinel id at tail slot ${i} (${bitWidth})`)
    t.ok(padded.scores[i] < -3e38, `sentinel score at tail slot ${i} (${bitWidth})`)
  }

  await expectRejects(
    t,
    () => idx.addWithIds(unitVec(0), new BigUint64Array([ids[0]])),
    `duplicate add should reject (${bitWidth})`
  )
  t.is(idx.length, N, `length unchanged after rejected duplicate (${bitWidth})`)

  t.is(await idx.remove(ids[2]), true, `remove resolves true for existing id (${bitWidth})`)
  t.is(await idx.remove(ids[2]), false, `remove resolves false for missing id (${bitWidth})`)
  t.absent(await idx.contains(ids[2]), `removed id is absent (${bitWidth})`)
  t.is(idx.length, N - 1, `length follows the remove (${bitWidth})`)
  await idx.compact()
  await idx.prepare()

  const file = tmpPath(`id-map-index-roundtrip-${bitWidth}`)
  try {
    await idx.write(file)
    assertTvimHeader(t, file, 2, bitWidth)
    await idx.dispose()

    const loaded = await IdMapIndex.load(file)
    t.is(loaded.dim, DIM, `dim restored (${bitWidth})`)
    t.is(loaded.bitWidth, bitWidth, `bitWidth restored (${bitWidth})`)
    t.is(loaded.length, N - 1, `length restored (${bitWidth})`)
    t.absent(await loaded.contains(ids[2]), `deletion persisted (${bitWidth})`)
    t.is(
      (await loaded.search(unitVec(0), 1)).ids[0],
      ids[0],
      `search works after reload (${bitWidth})`
    )
    await loaded.dispose()
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

// Deterministic pseudo-random numbers in [-0.5, 0.5). This is mulberry32, a
// small public-domain 32-bit generator; the shift amounts and odd constants are
// its published ones, not tuning values. A fixed seed gives every platform the
// same rows, so a failure reproduces.
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    const uint32 = (x ^ (x >>> 14)) >>> 0
    return uint32 / 2 ** 32 - 0.5
  }
}

// `rows` unit-length TurboVec rows, laid out row after row. Independent random
// rows are far apart (at dim 128 the closest pair of 1000 has cosine about
// 0.43), so a search for a stored row has one clear answer even after 4-bit
// encoding.
function seededUnitRows(rows, seed) {
  const next = mulberry32(seed)
  const vectors = new Float32Array(rows * TURBOVEC_DIM)
  for (let row = 0; row < rows; row++) {
    const vector = vectors.subarray(row * TURBOVEC_DIM, (row + 1) * TURBOVEC_DIM)
    for (let col = 0; col < TURBOVEC_DIM; col++) vector[col] = next()
    normalizeInPlace(vector)
  }
  return vectors
}

function normalizeInPlace(vector) {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < vector.length; i++) vector[i] /= norm
}

async function runTurboVecRoundTrip(t, storage, bitWidth) {
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
    await idx.addWithIds(vectors, ids)
    for (let i = 0; i < localN; i++) {
      const query = vectors.subarray(i * TURBOVEC_DIM, (i + 1) * TURBOVEC_DIM)
      t.is((await idx.search(query, 1)).ids[0], ids[i], `${storage} query=${i} retrieves itself`)
    }

    const query = vectors.subarray(0, TURBOVEC_DIM)
    t.is(
      (await idx.searchFiltered(query, 1, new BigUint64Array([ids[0]]))).ids[0],
      ids[0],
      `${storage} filtered search works`
    )
    await idx.buildIvf(4, 0)
    t.is((await idx.searchIvf(query, 1, 4)).ids[0], ids[0], `${storage} IVF search works`)
    await idx.write(file)
    const addLoggedError = await expectRejects(
      t,
      () => idx.addLogged(query, new BigUint64Array([9999n]), delta),
      `${storage} addLogged should be rejected`
    )
    if (addLoggedError !== null) {
      t.is(addLoggedError.message, 'InvalidArgument', `${storage} addLogged error category`)
    }
    const removeLoggedError = await expectRejects(
      t,
      () => idx.removeLogged(ids[0], delta),
      `${storage} removeLogged should be rejected`
    )
    if (removeLoggedError !== null) {
      t.is(removeLoggedError.message, 'InvalidArgument', `${storage} removeLogged error category`)
    }
    assertTv8Header(t, file, bitWidth)
    await expectRejects(
      t,
      () => IdMapIndex.loadMmap(file),
      `${storage} mmap load should be rejected`
    )
    loaded = await IdMapIndex.load(file)
    t.is((await loaded.search(query, 1)).ids[0], ids[0], `${storage} reload search works`)
  } finally {
    if (loaded !== null) await loaded.dispose()
    await idx.dispose()
    if (fs.existsSync(file)) fs.unlinkSync(file)
    removeDeltaArtifacts(delta)
  }
}

test('IdMapIndex: package root and ./idMapIndex subpath export the same class', (t) => {
  const rootModule = require('@qvac/turbovec-ggml')

  t.is(rootModule, IdMapIndex, 'root and subpath resolve to the same constructor')
  t.is(rootModule.IdMapIndex, IdMapIndex, 'root named class export matches')
  t.is(rootModule.default, IdMapIndex, 'root default export matches')
  t.is(rootModule.IdMapIndexFilter, IdMapIndex.IdMapIndexFilter, 'root filter export matches')
  t.is(
    require('@qvac/turbovec-ggml/idMapIndex.js'),
    IdMapIndex,
    './idMapIndex.js alias from embed-llamacpp resolves to the same class'
  )

  const idx = new rootModule.IdMapIndex({ dim: DIM })
  t.is(idx.dim, DIM, 'instance built from the root export is usable')
  t.is(idx.length, 0, 'instance built from the root export starts empty')
  idx.dispose()
})

for (const bitWidth of [4, 8, 32]) {
  test(`IdMapIndex: ${bitWidth}-bit add + search + remove + persistence round-trip`, async (t) => {
    await runRoundTrip(t, bitWidth)
  })
}

test('IdMapIndex: TurboVec q4 add + search + persistence round-trip', async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    expectThrows(
      t,
      () => new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q4' }),
      'TurboVec q4 requires a 64-bit target'
    )
    return
  }
  await runTurboVecRoundTrip(t, 'turbovec-q4', 4)
})

test('IdMapIndex: TurboVec q2 add + search + persistence round-trip', async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    expectThrows(
      t,
      () => new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q2' }),
      'TurboVec q2 requires a 64-bit target'
    )
    return
  }
  await runTurboVecRoundTrip(t, 'turbovec-q2', 2)
})

test('IdMapIndex: validates production bit widths and TurboVec dimensions', async (t) => {
  expectThrows(
    t,
    () => new IdMapIndex({ dim: DIM, bitWidth: 16 }),
    'bitWidth 16 should be rejected'
  )
  for (const bitWidth of ['8', 'constructor']) {
    const error = expectThrows(
      t,
      () => new IdMapIndex({ dim: DIM, bitWidth }),
      `non-numeric bitWidth ${JSON.stringify(bitWidth)} should be rejected`
    )
    t.is(
      error && error.message,
      'IdMapIndex: bitWidth must be 2, 4, 8, or 32',
      `non-numeric bitWidth ${JSON.stringify(bitWidth)} gets the bitWidth error`
    )
  }
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
      const max = new IdMapIndex({ dim: 16384, storage })
      const vector = new Float32Array(16384)
      vector[0] = 1
      await max.addWithIds(vector, new BigUint64Array([16384n]))
      t.is((await max.search(vector, 1)).ids[0], 16384n, `${storage} searches at maximum dimension`)
      await max.dispose()
    }
  }
  expectThrows(
    t,
    () => new IdMapIndex({ dim: 16392, storage: 'turbovec-q2' }),
    'TurboVec dimensions must not exceed 16384'
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

test('IdMapIndex: a null bitWidth counts as the default 8, as in embed-llamacpp', (t) => {
  const alone = new IdMapIndex({ dim: DIM, bitWidth: null })
  t.is(alone.bitWidth, 8, 'null bitWidth alone selects q8')
  alone.dispose()

  const withQ8 = new IdMapIndex({ dim: DIM, storage: 'q8', bitWidth: null })
  t.is(withQ8.bitWidth, 8, 'null bitWidth is accepted with q8 storage')
  withQ8.dispose()

  const error = expectThrows(
    t,
    () => new IdMapIndex({ dim: DIM, storage: 'q4', bitWidth: null }),
    'null bitWidth with q4 storage is a mismatch'
  )
  t.is(error && error.message, 'IdMapIndex: bitWidth does not match storage', 'mismatch error')
})

// The class always resolves `bitWidth` to a storage name, so the native
// boundary takes `{ dim, storage }` only. Desktop-only: the relative binding
// path does not resolve after the mobile test app copies integration tests.
test('IdMapIndex: native create takes dim and storage only', { skip: IS_MOBILE }, (t) => {
  const binding = require('../../binding')
  for (const [storage, bitWidth] of [
    ['f32', 32],
    ['q8', 8],
    ['q4', 4]
  ]) {
    const handle = binding.idx_create({ dim: DIM, storage })
    t.is(binding.idx_bit_width(handle), bitWidth, `${storage} creates a ${bitWidth}-bit index`)
    binding.idx_dispose(handle)
  }
  expectThrows(t, () => binding.idx_create({ dim: DIM }), 'missing storage is rejected')
  expectThrows(
    t,
    () => binding.idx_create({ dim: DIM, bitWidth: 32 }),
    'bitWidth without storage is rejected'
  )
  expectThrows(
    t,
    () => binding.idx_create({ dim: DIM, storage: 'q16' }),
    'unknown storage is rejected'
  )
  expectThrows(
    t,
    () => binding.idx_create({ dim: DIM, storage: 32 }),
    'non-string storage is rejected'
  )
})

// Bare's typed getters do no type checking and can crash on a value of the
// wrong type, so each native entry point must throw instead, before it starts
// any work. Desktop-only for the same reason as the test above.
test('IdMapIndex: native calls reject wrong argument types', { skip: IS_MOBILE }, (t) => {
  const binding = require('../../binding')
  const handle = binding.idx_create({ dim: DIM, storage: 'f32' })
  const vector = new Float32Array(DIM)
  const cases = {
    'non-object create options': () => binding.idx_create(5),
    'non-string load path': () => binding.idx_load_async(42),
    'plain-array vectors': () => binding.idx_add_async(handle, [1, 2], new BigUint64Array(1)),
    'number ids': () => binding.idx_add_async(handle, vector, 5),
    'string k': () => binding.idx_search_async(handle, vector, 'x'),
    'number id': () => binding.idx_remove_async(handle, 5),
    'number handle': () => binding.idx_len(5),
    'missing handle': () => binding.idx_compact_async(),
    'object filter handle': () => binding.idx_search_prepared_filtered_async(handle, {}, vector, 1)
  }
  try {
    for (const [name, fn] of Object.entries(cases)) {
      const error = expectThrows(t, fn, `${name} is rejected`)
      t.is(error && error.code, errorCode('InvalidArgument'), `${name} throws InvalidArgument`)
    }
  } finally {
    binding.idx_dispose(handle)
  }
})

test('IdMapIndex: paths with a NUL character are rejected, not truncated', async (t) => {
  const file = tmpPath('id-map-index-nul-path')
  const delta = tmpDeltaPath('id-map-index-nul-path')
  const idx = new IdMapIndex({ dim: 2, bitWidth: 8 })
  try {
    await idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([11n]))

    let error = await expectRejects(
      t,
      () => idx.write(`${file}\0.junk`),
      'write rejects a NUL path'
    )
    t.is(error && error.code, errorCode('InvalidArgument'), 'write rejects with InvalidArgument')
    t.absent(fs.existsSync(file), 'write did not create the truncated path')

    await idx.write(file)
    const loaders = {
      load: () => IdMapIndex.load(`${file}\0.junk`),
      loadMmap: () => IdMapIndex.loadMmap(`${file}\0.junk`),
      loadWithDelta: () => IdMapIndex.loadWithDelta(file, `${delta}\0.junk`)
    }
    for (const [name, load] of Object.entries(loaders)) {
      error = await expectRejects(t, load, `${name} rejects a NUL path`)
      t.is(
        error && error.code,
        errorCode('InvalidArgument'),
        `${name} rejects with InvalidArgument`
      )
    }
    t.absent(fs.existsSync(delta), 'loadWithDelta did not bind the truncated delta path')
  } finally {
    await idx.dispose()
    if (fs.existsSync(file)) fs.unlinkSync(file)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: ESM wrappers expose named exports', async (t) => {
  const idMapModule = await import('@qvac/turbovec-ggml/idMapIndex')
  t.is(idMapModule.default, idMapModule.IdMapIndex, 'subpath default and named class match')
  t.ok(idMapModule.IdMapIndexFilter, 'subpath named filter export exists')
  const rootModule = await import('@qvac/turbovec-ggml')
  t.is(rootModule.default, rootModule.IdMapIndex, 'root default and named class match')
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
  const rootModule = require('@qvac/turbovec-ggml')
  const DirectIdMapIndex = require('@qvac/turbovec-ggml/idMapIndex')
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

test('IdMapIndex: static loaders resolve to the class they are called on', async (t) => {
  class ExtendedIdMapIndex extends IdMapIndex {
    extendedMethod() {
      return 'extended'
    }
  }

  const snapshot = tmpPath('id-map-index-subclass-load')
  const delta = tmpDeltaPath('id-map-index-subclass-load')
  // One loaded index at a time: an open mmap may hold a file lock, and
  // Windows enforces locks against other reads of the same snapshot.
  let current = null
  try {
    const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
    await idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))
    await idx.write(snapshot)
    await idx.dispose()

    const loaders = {
      load: () => ExtendedIdMapIndex.load(snapshot),
      loadMmap: () => ExtendedIdMapIndex.loadMmap(snapshot),
      loadWithDelta: () => ExtendedIdMapIndex.loadWithDelta(snapshot, delta)
    }
    for (const [name, load] of Object.entries(loaders)) {
      current = await load()
      t.is(
        Object.getPrototypeOf(current),
        ExtendedIdMapIndex.prototype,
        `${name} keeps the subclass`
      )
      t.is(current.extendedMethod(), 'extended', `${name} exposes subclass methods`)
      t.is(
        (await current.search(new Float32Array([0, 1]), 1)).ids[0],
        22n,
        `${name} result is searchable`
      )
      await current.dispose()
      current = null
    }

    current = await IdMapIndex.load(snapshot)
    t.is(Object.getPrototypeOf(current), IdMapIndex.prototype, 'base class load returns IdMapIndex')
    await current.dispose()
    current = null

    const { load } = IdMapIndex
    current = await load(snapshot)
    t.is(
      Object.getPrototypeOf(current),
      IdMapIndex.prototype,
      'detached load falls back to IdMapIndex'
    )
  } finally {
    if (current !== null) await current.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: dispose releases many prepared filters', async (t) => {
  // 300 crosses several filter-pruning thresholds.
  const count = 300
  const idx = new IdMapIndex({ dim: 2, bitWidth: 8 })
  const filters = []
  try {
    await idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))
    for (let i = 0; i < count; i++) {
      filters.push(await idx.prepareFilter(new BigUint64Array([22n])))
    }
    for (let i = 0; i < count; i += 2) {
      filters[i].dispose()
    }
    t.is(
      (await filters[1].search(new Float32Array([0, 1]), 1)).ids[0],
      22n,
      'live filter still searches'
    )
  } finally {
    await idx.dispose()
  }

  let disposed = 0
  for (const filter of filters) {
    try {
      await filter.search(new Float32Array([0, 1]), 1)
    } catch (error) {
      if (error.message === 'IdMapIndexFilter has been disposed') disposed += 1
    }
    filter.dispose()
  }
  t.is(disposed, count, 'index dispose releases every remaining filter')
})

test('IdMapIndex: CommonJS TypeScript default import works without interop', (t) => {
  const consumer = require('../types/consumer-cjs.test.js')
  const idMapModule = require('@qvac/turbovec-ggml/idMapIndex')

  t.is(
    consumer.getRootDefaultImport(),
    IdMapIndex,
    'package root default import resolves to the class'
  )
  t.is(consumer.getDefaultImport(), IdMapIndex, 'CommonJS default import resolves to the class')
  t.is(idMapModule.IdMapIndex, IdMapIndex, 'named class export remains aligned')
  t.is(
    idMapModule.IdMapIndexFilter,
    IdMapIndex.IdMapIndexFilter,
    'named filter export remains aligned'
  )
})

test('IdMapIndex: rejects numeric arguments outside int32 range', async (t) => {
  const tooLarge = 0x80000000
  expectThrows(t, () => new IdMapIndex({ dim: tooLarge }), 'oversized dim should be rejected')
  const idx = new IdMapIndex({ dim: 2 })
  let filter = null
  try {
    await idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([1n]))
    filter = await idx.prepareFilter(new BigUint64Array([1n]))
    await expectRejects(
      t,
      () => idx.search(new Float32Array([1, 0]), tooLarge),
      'oversized k rejected'
    )
    await expectRejects(
      t,
      () => idx.searchFiltered(new Float32Array([1, 0]), tooLarge, new BigUint64Array([1n])),
      'oversized filtered k rejected'
    )
    await expectRejects(
      t,
      () => filter.search(new Float32Array([1, 0]), tooLarge),
      'oversized prepared-filter k rejected'
    )
    await expectRejects(t, () => idx.buildIvf(tooLarge, 0), 'oversized nLists rejected')
    await expectRejects(
      t,
      () => idx.searchIvf(new Float32Array([1, 0]), 1, tooLarge),
      'oversized nProbe rejected'
    )
  } finally {
    if (filter !== null) filter.dispose()
    await idx.dispose()
  }
})

test('IdMapIndex: load APIs reject invalid input', async (t) => {
  await expectRejects(t, () => IdMapIndex.load(''), 'load invalid path rejects')
  await expectRejects(t, () => IdMapIndex.loadMmap(''), 'loadMmap invalid path rejects')
  await expectRejects(
    t,
    () => IdMapIndex.loadWithDelta('', ''),
    'loadWithDelta invalid paths reject'
  )
})

test('IdMapIndex: rejects mismatched empty-id add', async (t) => {
  const idx = new IdMapIndex({ dim: 2 })
  await expectRejects(
    t,
    () => idx.addWithIds(new Float32Array([1, 2]), new BigUint64Array()),
    'vectors with empty ids should be rejected'
  )
  t.is(idx.length, 0, 'failed add does not mutate')
  await idx.addWithIds(new Float32Array(), new BigUint64Array())
  t.is(idx.length, 0, 'empty add remains a no-op')
  await idx.dispose()
})

test('IdMapIndex: BigInt id range edge cases', async (t) => {
  const idx = new IdMapIndex({ dim: 2 })
  const edge = (1n << 63n) + 7n
  await idx.addWithIds(new Float32Array([0.5, 0.5]), new BigUint64Array([edge]))
  t.ok(await idx.contains(edge), 'high-bit id round-trips')
  t.is((await idx.search(new Float32Array([0.5, 0.5]), 1)).ids[0], edge, 'high-bit id surfaces')
  await expectRejects(
    t,
    () => idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([UINT64_MAX])),
    'UINT64_MAX is reserved for padding'
  )
  await idx.dispose()
})

test('IdMapIndex: filtered and prepared-filter searches restrict allowed ids', async (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  let filter = null
  try {
    await idx.addWithIds(
      new Float32Array([1, 0, 0, 1, 0.5, 0.5]),
      new BigUint64Array([11n, 22n, 33n])
    )
    const out = await idx.searchFiltered(
      new Float32Array([1, 0]),
      2,
      new BigUint64Array([22n, 33n, 44n])
    )
    t.is(out.ids[0], 33n, 'best allowed id wins')
    t.is(out.ids[1], 22n, 'lower-scoring allowed id follows')

    filter = await idx.prepareFilter(new BigUint64Array([22n, 33n]))
    t.is(
      (await filter.search(new Float32Array([0, 1]), 1)).ids[0],
      22n,
      'prepared filter is reusable'
    )
    await idx.addWithIds(new Float32Array([0.25, 0.75]), new BigUint64Array([44n]))
    await expectDisposedFilter(t, filter, 'mutation invalidates prepared filter')
  } finally {
    if (filter !== null) filter.dispose()
    await idx.dispose()
  }
})

test('IdMapIndex: every mutation path disposes prepared filters when required', async (t) => {
  const snapshot = tmpPath('id-map-index-filter-invalidation-snapshot')
  const delta = tmpDeltaPath('id-map-index-filter-invalidation-delta')
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  let filter = null
  try {
    await idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))

    filter = await idx.prepareFilter(new BigUint64Array([11n]))
    t.is(await idx.remove(999n), false, 'missing plain remove is a no-op')
    t.is(
      (await filter.search(new Float32Array([1, 0]), 1)).ids[0],
      11n,
      'no-op remove preserves filter'
    )
    t.is(await idx.remove(22n), true, 'plain remove mutates the index')
    await expectDisposedFilter(t, filter, 'successful remove invalidates prepared filter')

    filter = await idx.prepareFilter(new BigUint64Array([11n]))
    await idx.compact()
    await expectDisposedFilter(t, filter, 'compact invalidates prepared filter')

    filter = await idx.prepareFilter(new BigUint64Array([11n]))
    await idx.buildIvf(1, 0)
    await expectDisposedFilter(t, filter, 'IVF build invalidates prepared filter')

    await idx.write(snapshot)
    filter = await idx.prepareFilter(new BigUint64Array([11n]))
    await idx.addLogged(new Float32Array([0.5, 0.5]), new BigUint64Array([33n]), delta)
    await expectDisposedFilter(t, filter, 'logged add invalidates prepared filter')

    filter = await idx.prepareFilter(new BigUint64Array([11n]))
    t.is(await idx.removeLogged(999n, delta), false, 'missing logged remove resolves false')
    await expectDisposedFilter(t, filter, 'logged remove invalidates prepared filter')

    filter = await idx.prepareFilter(new BigUint64Array([11n]))
    await idx.compactDelta(snapshot, delta)
    await expectDisposedFilter(t, filter, 'delta compaction invalidates prepared filter')
  } finally {
    if (filter !== null) filter.dispose()
    await idx.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: TurboVec IVF build disposes prepared filters', async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    t.pass('TurboVec requires a 64-bit target')
    return
  }
  const rows = 64
  const ids = new BigUint64Array(rows)
  for (let i = 0; i < rows; i++) ids[i] = 9000n + BigInt(i)
  const vectors = seededUnitRows(rows, CALIBRATION_SEED)
  const query = vectors.subarray(0, TURBOVEC_DIM)
  const idx = new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q4' })
  let filter = null
  try {
    await idx.addWithIds(vectors, ids)
    filter = await idx.prepareFilter(new BigUint64Array([ids[0], ids[rows - 1]]))
    t.is((await filter.search(query, 1)).ids[0], ids[0], 'prepared filter works before the build')
    await idx.buildIvf(8, 0)
    await expectDisposedFilter(t, filter, 'TurboVec IVF build invalidates prepared filter')

    filter = await idx.prepareFilter(new BigUint64Array([ids[0], ids[rows - 1]]))
    t.is((await filter.search(query, 1)).ids[0], ids[0], 'a filter prepared after the build works')
    t.is((await idx.searchIvf(query, 1, 8)).ids[0], ids[0], 'IVF search works after the build')
  } finally {
    if (filter !== null) filter.dispose()
    await idx.dispose()
  }
})

test('IdMapIndex: IVF build and search lifecycle', async (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  await idx.addWithIds(
    new Float32Array([1, 0, 0, 1, 0.5, 0.5, -1, 0]),
    new BigUint64Array([11n, 22n, 33n, 44n])
  )
  await expectRejects(
    t,
    () => idx.searchIvf(new Float32Array([1, 0]), 1, 1),
    'IVF search before build should reject'
  )
  await idx.buildIvf(4, 0)
  t.is((await idx.searchIvf(new Float32Array([1, 0]), 2, 4)).ids[0], 11n, 'IVF nearest id')
  await idx.addWithIds(new Float32Array([0.25, 0.75]), new BigUint64Array([55n]))
  await expectRejects(
    t,
    () => idx.searchIvf(new Float32Array([1, 0]), 1, 4),
    'mutation invalidates IVF'
  )
  await idx.dispose()
})

test('IdMapIndex: v4 delta log replay and compaction', async (t) => {
  const snapshot = tmpPath('id-map-index-delta-snapshot')
  const delta = tmpDeltaPath('id-map-index-delta-log')
  let idx = null
  let replayed = null
  let compacted = null
  try {
    idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
    await idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))
    await idx.write(snapshot)
    await idx.addLogged(new Float32Array([0.5, 0.5]), new BigUint64Array([33n]), delta)
    t.is(await idx.removeLogged(11n, delta), true, 'logged remove resolves true for existing id')
    t.is(await idx.removeLogged(44n, delta), false, 'logged remove resolves false for absent id')
    assertTvidHeader(t, delta)

    replayed = await IdMapIndex.loadWithDelta(snapshot, delta)
    t.absent(await replayed.contains(11n), 'delta replay applies remove')
    t.ok(await replayed.contains(22n), 'delta replay keeps snapshot id')
    t.ok(await replayed.contains(33n), 'delta replay applies add')
    await expectRejects(
      t,
      () => replayed.addWithIds(new Float32Array(), new BigUint64Array()),
      'delta-bound handle rejects an empty plain add'
    )
    await replayed.dispose()
    replayed = null

    await idx.compactDelta(snapshot, delta)
    assertTvimHeader(t, snapshot, 2, 4)
    assertTvidHeader(t, delta)
    await idx.dispose()
    idx = null
    compacted = await IdMapIndex.loadWithDelta(snapshot, delta)
    t.absent(await compacted.contains(11n), 'compacted snapshot excludes removed id')
    t.ok(await compacted.contains(33n), 'compacted snapshot includes logged add')
  } finally {
    if (idx !== null) await idx.dispose()
    if (replayed !== null) await replayed.dispose()
    if (compacted !== null) await compacted.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: stale delta writers retain catch-up on a missing remove', async (t) => {
  const snapshot = tmpPath('id-map-index-stale-writer-snapshot')
  const delta = tmpDeltaPath('id-map-index-stale-writer-log')
  let first = null
  let stale = null
  try {
    const seed = new IdMapIndex({ dim: 2, bitWidth: 4 })
    await seed.addWithIds(new Float32Array([1, 0]), new BigUint64Array([11n]))
    await seed.write(snapshot)
    await seed.dispose()

    first = await IdMapIndex.loadWithDelta(snapshot, delta)
    stale = await IdMapIndex.loadWithDelta(snapshot, delta)
    await first.addLogged(new Float32Array([0, 1]), new BigUint64Array([22n]), delta)
    t.is(await stale.removeLogged(999n, delta), false, 'missing remove resolves false')
    t.ok(await stale.contains(22n), 'stale writer retains catch-up before missing remove')
    t.is(stale.length, 2, 'length includes the caught-up add')
  } finally {
    if (first !== null) await first.dispose()
    if (stale !== null) await stale.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: missing and corrupt delta logs', async (t) => {
  const snapshot = tmpPath('id-map-index-delta-errors')
  const delta = tmpDeltaPath('id-map-index-delta-errors')
  let idx = null
  let loaded = null
  try {
    idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
    await idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([11n]))
    await idx.write(snapshot)
    loaded = await IdMapIndex.loadWithDelta(snapshot, delta)
    t.ok(await loaded.contains(11n), 'missing delta log replays as empty')
    await loaded.addLogged(new Float32Array([0, 1]), new BigUint64Array([22n]), delta)
    await loaded.addLogged(new Float32Array([1, 0]), new BigUint64Array([23n]), delta)
    await loaded.dispose()
    loaded = null
    const corrupt = fs.readFileSync(delta)
    corrupt[64] ^= 1
    fs.writeFileSync(delta, corrupt)
    await expectRejects(
      t,
      () => IdMapIndex.loadWithDelta(snapshot, delta),
      'corrupt delta log should reject'
    )
  } finally {
    if (idx !== null) await idx.dispose()
    if (loaded !== null) await loaded.dispose()
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot)
    removeDeltaArtifacts(delta)
  }
})

test('IdMapIndex: rejects non-finite vectors and queries', async (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 8 })
  await expectRejects(
    t,
    () => idx.addWithIds(new Float32Array([1, Infinity]), new BigUint64Array([1n])),
    'non-finite vector should be rejected'
  )
  await idx.addWithIds(new Float32Array([1, 0]), new BigUint64Array([1n]))
  await expectRejects(
    t,
    () => idx.search(new Float32Array([NaN, 0]), 1),
    'non-finite query should be rejected'
  )
  await idx.dispose()

  if (SUPPORTS_TURBOVEC) {
    for (const storage of ['turbovec-q2', 'turbovec-q4']) {
      const turbovec = new IdMapIndex({ dim: 8, storage })
      const valid = new Float32Array(8)
      valid[0] = 1
      await expectRejects(
        t,
        () =>
          turbovec.addWithIds(
            new Float32Array([1e16, 0, 0, 0, 0, 0, 0, 0]),
            new BigUint64Array([1n])
          ),
        `${storage} rejects finite components at the magnitude limit`
      )
      await turbovec.addWithIds(valid, new BigUint64Array([1n]))
      await expectRejects(
        t,
        () => turbovec.search(new Float32Array([1e16, 0, 0, 0, 0, 0, 0, 0]), 1),
        `${storage} rejects finite query components at the magnitude limit`
      )
      await turbovec.dispose()
    }
  }
})

test('IdMapIndex: mmap load is searchable and read-only', async (t) => {
  const file = tmpPath('id-map-index-mmap')
  let mmap = null
  try {
    const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
    await idx.addWithIds(new Float32Array([1, 0, 0, 1]), new BigUint64Array([11n, 22n]))
    await idx.write(file)
    await idx.dispose()
    mmap = await IdMapIndex.loadMmap(file)
    t.is((await mmap.search(new Float32Array([0, 1]), 1)).ids[0], 22n, 'mmap search works')
    await expectRejects(
      t,
      () => mmap.addWithIds(new Float32Array(), new BigUint64Array()),
      'mmap handle rejects an empty add'
    )
    await expectRejects(
      t,
      () => mmap.addWithIds(new Float32Array([0.5, 0.5]), new BigUint64Array([33n])),
      'mmap add should be rejected'
    )
    await expectRejects(t, () => mmap.remove(11n), 'mmap remove should be rejected')
  } finally {
    if (mmap !== null) await mmap.dispose()
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})

test('IdMapIndex: dispose is deterministic and idempotent', async (t) => {
  const idx = new IdMapIndex({ dim: 2, bitWidth: 4 })
  await idx.dispose()
  await idx.dispose()
  await expectRejects(t, () => idx.contains(1n), 'disposed contains should reject')
  expectThrows(t, () => idx.length, 'disposed length should throw')
})

test('IdMapIndex: corrupt persistence file load fails', async (t) => {
  const file = tmpPath('id-map-index-corrupt')
  try {
    fs.writeFileSync(file, new Uint8Array(32))
    const error = await expectRejects(
      t,
      () => IdMapIndex.load(file),
      'corrupt tvim file should reject'
    )
    if (error !== null) t.is(error.message, 'BadMagic', 'load preserves native error category')
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})

test(`IdMapIndex: TurboVec calibrates from a first add of ${AUTO_CALIBRATE_MIN_ROWS} rows`, async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    t.pass('TurboVec requires a 64-bit target')
    return
  }
  const rows = AUTO_CALIBRATE_MIN_ROWS
  // Not normalizedPatternVec: it repeats with a period near 2 * pi * 113, so its
  // row 710 is a near-copy of row 0 and a 4-bit search can return either.
  const vectors = seededUnitRows(rows, CALIBRATION_SEED)
  const ids = new BigUint64Array(rows)
  for (let i = 0; i < rows; i++) ids[i] = BigInt(i + 1)
  const file = tmpPath('id-map-index-turbovec-calibrated')
  const idx = new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q4' })
  const small = new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q4' })
  const q2 = new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q2' })
  const plain = new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'q8' })
  let loaded = null
  try {
    t.is(idx.calibrated, false, 'a fresh index is uncalibrated')
    await idx.addWithIds(vectors, ids)
    t.is(idx.calibrated, true, `a first add of ${AUTO_CALIBRATE_MIN_ROWS} rows calibrates`)
    const query = vectors.subarray(0, TURBOVEC_DIM)
    t.is((await idx.search(query, 1)).ids[0], ids[0], 'a calibrated index retrieves a stored row')
    await idx.write(file)
    loaded = await IdMapIndex.load(file)
    t.is(loaded.calibrated, true, 'the calibration survives a snapshot')

    const belowMin = AUTO_CALIBRATE_MIN_ROWS - 1
    await small.addWithIds(vectors.subarray(0, belowMin * TURBOVEC_DIM), ids.subarray(0, belowMin))
    t.is(small.calibrated, false, 'a first add one row short of the minimum does not calibrate')

    const repeated = ids.slice()
    repeated[rows - 1] = repeated[0]
    await expectRejects(
      t,
      () => q2.addWithIds(vectors, repeated),
      'a first add with a repeated id is rejected'
    )
    t.is(q2.calibrated, false, 'a rejected first add does not calibrate')
    await q2.addWithIds(new Float32Array(0), new BigUint64Array(0))
    t.is(q2.calibrated, false, 'an empty first add does not calibrate')
    await q2.addWithIds(vectors, ids)
    t.is(q2.calibrated, true, 'a q2 index still calibrates on its first rows')

    await plain.addWithIds(vectors, ids)
    t.is(plain.calibrated, false, 'other storages are never calibrated')
  } finally {
    if (loaded !== null) await loaded.dispose()
    await idx.dispose()
    await small.dispose()
    await q2.dispose()
    await plain.dispose()
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})

test('IdMapIndex: TurboVec staged search is off until turned on', async (t) => {
  if (!SUPPORTS_TURBOVEC) {
    t.pass('TurboVec requires a 64-bit target')
    return
  }
  const file = tmpPath('id-map-index-turbovec-staged')
  const idx = new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'turbovec-q4' })
  const plain = new IdMapIndex({ dim: TURBOVEC_DIM, storage: 'q8' })
  let loaded = null
  try {
    t.is(idx.stagedSearch, false, 'a new index has staged search off')
    await idx.setStagedSearch(true)
    t.is(idx.stagedSearch, true, 'staged search can be turned on')
    await idx.addWithIds(normalizedPatternVec(0), new BigUint64Array([1n]))
    t.is((await idx.search(normalizedPatternVec(0), 1)).ids[0], 1n, 'search works with it on')
    t.is(idx.stagedSearch, true, 'a mutation keeps the setting')
    await idx.write(file)
    loaded = await IdMapIndex.load(file)
    t.is(loaded.stagedSearch, false, 'a loaded index has staged search off')
    await idx.setStagedSearch(false)
    t.is(idx.stagedSearch, false, 'staged search can be turned off again')

    await expectRejects(t, () => idx.setStagedSearch(1), 'a non-boolean is rejected')
    await expectRejects(t, () => plain.setStagedSearch(true), 'other storages reject it')
    t.is(plain.stagedSearch, false, 'other storages report it off')
  } finally {
    if (loaded !== null) await loaded.dispose()
    await idx.dispose()
    await plain.dispose()
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})
