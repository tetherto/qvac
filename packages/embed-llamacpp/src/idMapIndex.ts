const HANDLE = Symbol('IdMapIndex.handle')
const FILTER_HANDLE = Symbol('IdMapIndexFilter.handle')
const FILTER_OWNER = Symbol('IdMapIndexFilter.owner')
const FILTERS = Symbol('IdMapIndex.filters')
const INT32_MAX = 0x7fffffff

const BIT_WIDTH_BY_STORAGE = {
  f32: 32,
  q8: 8,
  q4: 4,
  'turbovec-q4': 4,
  'turbovec-q2': 2
} as const

const STORAGE_BY_BIT_WIDTH = {
  2: 'turbovec-q2',
  4: 'q4',
  8: 'q8',
  32: 'f32'
} as const

type NativeHandle = object

interface IdMapIndexBinding {
  idx_create(options: Required<IdMapIndexOptions>): NativeHandle
  idx_load(path: string): NativeHandle
  idx_load_mmap(path: string): NativeHandle
  idx_load_with_delta(snapshotPath: string, deltaPath: string): NativeHandle
  idx_add(handle: NativeHandle, vectors: Float32Array, ids: BigUint64Array): void
  idx_add_logged(
    handle: NativeHandle,
    vectors: Float32Array,
    ids: BigUint64Array,
    deltaPath: string
  ): void
  idx_search(handle: NativeHandle, queries: Float32Array, k: number): IdMapIndexSearchResult
  idx_search_filtered(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    allowedIds: BigUint64Array
  ): IdMapIndexSearchResult
  idx_filter_create(handle: NativeHandle, allowedIds: BigUint64Array): NativeHandle
  idx_search_prepared_filtered(
    handle: NativeHandle,
    filterHandle: NativeHandle,
    queries: Float32Array,
    k: number
  ): IdMapIndexSearchResult
  idx_build_ivf(handle: NativeHandle, nLists: number, nIter: number): void
  idx_search_ivf(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    nProbe: number
  ): IdMapIndexSearchResult
  idx_remove(handle: NativeHandle, id: bigint): boolean
  idx_remove_logged(handle: NativeHandle, id: bigint, deltaPath: string): boolean
  idx_compact(handle: NativeHandle): void
  idx_contains(handle: NativeHandle, id: bigint): boolean
  idx_prepare(handle: NativeHandle): void
  idx_write(handle: NativeHandle, path: string): void
  idx_compact_delta(handle: NativeHandle, snapshotPath: string, deltaPath: string): void
  idx_dispose(handle: NativeHandle): void
  idx_filter_dispose(handle: NativeHandle): void
  idx_len(handle: NativeHandle): number
  idx_dim(handle: NativeHandle): number
  idx_bit_width(handle: NativeHandle): IdMapIndexBitWidth
}

let binding: IdMapIndexBinding | undefined

function loadBinding() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- The native Bare binding is resolved lazily through CommonJS.
  binding ??= require('./binding') as IdMapIndexBinding
  return binding
}

function finalizeFilterHandle(handle: NativeHandle) {
  try {
    loadBinding().idx_filter_dispose(handle)
  } catch {
    // Finalizers cannot report cleanup failures to user code.
  }
}

const filterFinalizer =
  typeof FinalizationRegistry === 'undefined'
    ? null
    : new FinalizationRegistry<NativeHandle>(finalizeFilterHandle)

function releaseFilter(owner: IdMapIndex, filter: IdMapIndexFilter) {
  for (const ref of owner[FILTERS]) {
    const candidate = ref.deref()
    if (candidate === undefined || candidate === filter) {
      owner[FILTERS].delete(ref)
    }
  }
}

export type IdMapIndexBitWidth = 2 | 4 | 8 | 32
export type IdMapIndexStorage = keyof typeof BIT_WIDTH_BY_STORAGE

export interface IdMapIndexOptions {
  /**
   * Vector dimensionality. TurboVec requires a 64-bit target and a dimension
   * divisible by 8 and no greater than 1,024.
   */
  dim: number
  /** 2 = TurboVec q2, 4 = q4, 8 = q8, and 32 = full f32 storage. Defaults to 8. */
  bitWidth?: IdMapIndexBitWidth
  /** Use `turbovec-q4` to distinguish TurboVec q4 from generic q4 storage. */
  storage?: IdMapIndexStorage
}

export interface IdMapIndexSearchResult {
  /**
   * Row-major similarity scores. f32/q4/q8 use dot products against stored or
   * dequantized vectors. TurboVec uses rotated/quantized storage with a
   * per-vector scale and rotated queries to approximate dot products. Higher
   * scores are closer.
   */
  scores: Float32Array
  /** Row-major external IDs. UINT64_MAX is used to pad short result rows. */
  ids: BigUint64Array
  /** Number of query rows. */
  m: number
  /** Requested result count per query. */
  k: number
}

function isPositiveInt32(value: number) {
  return Number.isInteger(value) && value > 0 && value <= INT32_MAX
}

function isNonNegativeInt32(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= INT32_MAX
}

function requireNonEmptyPath(value: string, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

function ensureHandle(index: IdMapIndex) {
  const handle = index[HANDLE]
  if (handle === null) {
    throw new Error('IdMapIndex has been disposed')
  }
  return handle
}

function normalizeStorageOptions(options: IdMapIndexOptions) {
  const hasBitWidth = options.bitWidth !== undefined
  const hasStorage = options.storage !== undefined
  let bitWidth: IdMapIndexBitWidth = options.bitWidth ?? 8
  let storage: IdMapIndexStorage | undefined = options.storage

  if (hasStorage) {
    if (
      typeof storage !== 'string' ||
      !Object.prototype.hasOwnProperty.call(BIT_WIDTH_BY_STORAGE, storage)
    ) {
      throw new TypeError(
        "IdMapIndex: storage must be 'f32', 'q8', 'q4', 'turbovec-q4', or 'turbovec-q2'"
      )
    }
    const expectedBitWidth = BIT_WIDTH_BY_STORAGE[storage]
    if (!hasBitWidth) {
      bitWidth = expectedBitWidth
    } else if (bitWidth !== expectedBitWidth) {
      throw new TypeError('IdMapIndex: bitWidth does not match storage')
    }
  } else {
    storage = STORAGE_BY_BIT_WIDTH[bitWidth]
  }

  if (storage === undefined) {
    throw new TypeError('IdMapIndex: bitWidth must be 2, 4, 8, or 32')
  }

  return { bitWidth, storage }
}

export class IdMapIndexFilter {
  [FILTER_HANDLE]: NativeHandle | null = null;
  [FILTER_OWNER]: IdMapIndex | null = null

  private constructor() {
    throw new TypeError('IdMapIndexFilter instances must be created by IdMapIndex.prepareFilter()')
  }

  /** Search with this prepared allowlist. Mutating the owner invalidates the filter. */
  search(queries: Float32Array, k: number) {
    if (!(queries instanceof Float32Array)) {
      throw new TypeError('IdMapIndexFilter.search: queries must be a Float32Array')
    }
    if (!isPositiveInt32(k)) {
      throw new TypeError('IdMapIndexFilter.search: k must be a positive int32')
    }
    const owner = this[FILTER_OWNER]
    const filterHandle = this[FILTER_HANDLE]
    if (owner === null || filterHandle === null) {
      throw new Error('IdMapIndexFilter has been disposed')
    }
    return loadBinding().idx_search_prepared_filtered(ensureHandle(owner), filterHandle, queries, k)
  }

  /** Release the prepared native filter. This operation is idempotent. */
  dispose() {
    const filterHandle = this[FILTER_HANDLE]
    if (filterHandle === null) {
      return
    }

    const owner = this[FILTER_OWNER]
    loadBinding().idx_filter_dispose(filterHandle)
    filterFinalizer?.unregister(this)
    this[FILTER_HANDLE] = null
    this[FILTER_OWNER] = null
    if (owner !== null) {
      releaseFilter(owner, this)
    }
  }
}

function createFilter(owner: IdMapIndex, handle: NativeHandle) {
  const filter = Object.create(IdMapIndexFilter.prototype) as IdMapIndexFilter
  filter[FILTER_OWNER] = owner
  filter[FILTER_HANDLE] = handle
  filterFinalizer?.register(filter, handle, filter)
  return filter
}

/**
 * CPU vector index with fixed dimensionality and stable uint64 external IDs.
 * Search uses exact or approximate dot products depending on storage. Callers
 * wanting cosine similarity should L2-normalize vectors before insertion and
 * queries before search. TurboVec normalizes indexed vectors while quantizing,
 * then restores their magnitude with a per-vector scale; it does not normalize
 * queries.
 */
export default class IdMapIndex {
  static Filter = IdMapIndexFilter
  static IdMapIndex = IdMapIndex
  static IdMapIndexFilter = IdMapIndexFilter;

  [HANDLE]: NativeHandle | null = null;
  [FILTERS] = new Set<WeakRef<IdMapIndexFilter>>()

  constructor(options: IdMapIndexOptions) {
    const { dim } = options ?? ({} as IdMapIndexOptions)
    if (!isPositiveInt32(dim)) {
      throw new TypeError('IdMapIndex: dim must be a positive int32')
    }
    const { bitWidth, storage } = normalizeStorageOptions(options)
    if (storage.startsWith('turbovec-') && (dim > 1_024 || dim % 8 !== 0)) {
      throw new RangeError(
        'IdMapIndex: TurboVec dim must be divisible by 8 and no greater than 1024'
      )
    }
    this[HANDLE] = loadBinding().idx_create({ dim, bitWidth, storage })
  }

  /**
   * Load a v2/v3 snapshot or migrate legacy v1 storage. Legacy bit-width 8
   * snapshots migrate to q8; other v1 widths migrate to f32. Older TurboVec
   * snapshots above 1,024 dimensions can be loaded and rewritten, but cannot
   * add, search, or build IVF state. Synchronous and potentially blocking.
   */
  static load(path: string) {
    requireNonEmptyPath(path, 'IdMapIndex.load: path')
    return IdMapIndex.fromHandle(loadBinding().idx_load(path))
  }

  /**
   * Load a v2 snapshot with read-only mmap-backed vectors. Legacy v1 and
   * TurboVec v3 snapshots are rejected. Requires a little-endian host and,
   * on POSIX, a filesystem supporting flock(). Mutations are rejected.
   */
  static loadMmap(path: string) {
    requireNonEmptyPath(path, 'IdMapIndex.loadMmap: path')
    return IdMapIndex.fromHandle(loadBinding().idx_load_mmap(path))
  }

  /**
   * Load a snapshot and replay its append-only delta log. A missing log is
   * treated as empty. The returned handle is bound to `deltaPath`; use logged
   * mutations and `compactDelta()` rather than plain mutations or `write()`.
   * Delta logs require a local filesystem with reliable cooperative locking.
   * TurboVec snapshots are rejected with `InvalidArgument`.
   */
  static loadWithDelta(snapshotPath: string, deltaPath: string) {
    requireNonEmptyPath(snapshotPath, 'IdMapIndex.loadWithDelta: snapshotPath')
    requireNonEmptyPath(deltaPath, 'IdMapIndex.loadWithDelta: deltaPath')
    return IdMapIndex.fromHandle(loadBinding().idx_load_with_delta(snapshotPath, deltaPath))
  }

  private static fromHandle(handle: NativeHandle) {
    const instance = Object.create(IdMapIndex.prototype) as IdMapIndex
    instance[HANDLE] = handle
    instance[FILTERS] = new Set()
    return instance
  }

  /**
   * Atomically add vectors with stable uint64 IDs. `vectors` is row-major and
   * must contain `ids.length * dim` finite components. TurboVec additionally
   * requires `abs(component) < 1e16`. UINT64_MAX is reserved.
   */
  addWithIds(vectors: Float32Array, ids: BigUint64Array) {
    this.validateBatch('addWithIds', vectors, ids)
    try {
      loadBinding().idx_add(ensureHandle(this), vectors, ids)
    } finally {
      this.disposeFilters()
    }
  }

  /**
   * Add vectors and append a durable v4 delta record. The index must first be
   * loaded from or successfully written to a snapshot. Delta logs are
   * state-bound and support one evolving writer; stale writers may catch up,
   * and that catch-up remains applied even if this add throws. A complete
   * record may also remain applied after a durability error, leaving the
   * handle requiring a reload. Store delta logs on a local filesystem with
   * reliable cooperative locking. TurboVec storage does not support logged
   * mutations.
   */
  addLogged(vectors: Float32Array, ids: BigUint64Array, deltaPath: string) {
    this.validateBatch('addLogged', vectors, ids)
    requireNonEmptyPath(deltaPath, 'addLogged: deltaPath')
    try {
      loadBinding().idx_add_logged(ensureHandle(this), vectors, ids, deltaPath)
    } finally {
      this.disposeFilters()
    }
  }

  /**
   * Top-k similarity search over row-major queries. Results are sorted
   * by descending score, then ascending ID. TurboVec rotates queries without
   * normalizing them and performs approximate rotated/quantized dot-product
   * scoring. TurboVec query components require `abs(value) < 1e16`. Short rows
   * use UINT64_MAX padding.
   */
  search(queries: Float32Array, k: number) {
    this.validateSearch('search', queries, k)
    return loadBinding().idx_search(ensureHandle(this), queries, k)
  }

  /** Exact search restricted to the supplied external IDs. */
  searchFiltered(queries: Float32Array, k: number, allowedIds: BigUint64Array) {
    this.validateSearch('searchFiltered', queries, k)
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError('searchFiltered: allowedIds must be a BigUint64Array')
    }
    return loadBinding().idx_search_filtered(ensureHandle(this), queries, k, allowedIds)
  }

  /**
   * Prepare an allowlist for repeated searches. Native mutation attempts
   * invalidate all prepared filters created from this index. Call `dispose()`
   * when done to release native filter memory promptly; dropped filters are
   * reclaimed by GC.
   */
  prepareFilter(allowedIds: BigUint64Array) {
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError('prepareFilter: allowedIds must be a BigUint64Array')
    }
    const filter = createFilter(
      this,
      loadBinding().idx_filter_create(ensureHandle(this), allowedIds)
    )
    this.pruneFilters()
    this[FILTERS].add(new WeakRef(filter))
    return filter
  }

  /**
   * Build deterministic in-memory IVF-flat search state. Mutations invalidate
   * it, and snapshots do not persist it.
   */
  buildIvf(nLists: number, nIter = 0) {
    if (!isPositiveInt32(nLists)) {
      throw new TypeError('buildIvf: nLists must be a positive int32')
    }
    if (!isNonNegativeInt32(nIter)) {
      throw new TypeError('buildIvf: nIter must be a non-negative int32')
    }
    loadBinding().idx_build_ivf(ensureHandle(this), nLists, nIter)
  }

  /**
   * Search the IVF-flat candidate lists. `buildIvf()` must have run after the
   * latest mutation or load. Higher `nProbe` generally improves recall.
   */
  searchIvf(queries: Float32Array, k: number, nProbe: number) {
    this.validateSearch('searchIvf', queries, k)
    if (!isPositiveInt32(nProbe)) {
      throw new TypeError('searchIvf: nProbe must be a positive int32')
    }
    return loadBinding().idx_search_ivf(ensureHandle(this), queries, k, nProbe)
  }

  /** Remove an ID, returning false when it is not present. */
  remove(id: bigint) {
    this.validateId('remove', id)
    const removed = loadBinding().idx_remove(ensureHandle(this), id)
    if (removed) {
      this.disposeFilters()
    }
    return removed
  }

  /**
   * Remove an ID and append a durable v4 delta record. Returns false when the
   * ID is absent. Stale-writer catch-up may still mutate the handle when this
   * method returns false or throws, and a complete record may remain applied
   * after a durability error. The same binding and reload rules as
   * `addLogged()` apply.
   */
  removeLogged(id: bigint, deltaPath: string) {
    this.validateId('removeLogged', id)
    requireNonEmptyPath(deltaPath, 'removeLogged: deltaPath')
    try {
      return loadBinding().idx_remove_logged(ensureHandle(this), id, deltaPath)
    } finally {
      this.disposeFilters()
    }
  }

  /** Physically reclaim tombstoned slots. Rejected on delta-bound handles. */
  compact() {
    try {
      loadBinding().idx_compact(ensureHandle(this))
    } finally {
      this.disposeFilters()
    }
  }

  /** Return whether the index contains an external ID. */
  contains(id: bigint) {
    this.validateId('contains', id)
    return loadBinding().idx_contains(ensureHandle(this), id)
  }

  /** Best-effort warmup of TurboVec rotation and codebook state. */
  prepare() {
    loadBinding().idx_prepare(ensureHandle(this))
  }

  /**
   * Persist a checksummed v2 snapshot for f32/q4/q8 or v3 for TurboVec.
   * Delta-bound handles must use `compactDelta()`. A NotDurable error means
   * replacement succeeded but parent-directory durability was not confirmed.
   */
  write(path: string) {
    requireNonEmptyPath(path, 'write: path')
    loadBinding().idx_write(ensureHandle(this), path)
  }

  /**
   * Write a fresh snapshot and reset its matching v4 delta log. A
   * PartialCompact error means replacement occurred but durability or log
   * reset could not be confirmed. TurboVec storage does not support delta
   * compaction and is rejected with `InvalidArgument`.
   */
  compactDelta(snapshotPath: string, deltaPath: string) {
    requireNonEmptyPath(snapshotPath, 'compactDelta: snapshotPath')
    requireNonEmptyPath(deltaPath, 'compactDelta: deltaPath')
    try {
      loadBinding().idx_compact_delta(ensureHandle(this), snapshotPath, deltaPath)
    } finally {
      this.disposeFilters()
    }
  }

  /** Number of live entries. */
  get length() {
    return loadBinding().idx_len(ensureHandle(this))
  }

  /** Vector dimensionality. */
  get dim() {
    return loadBinding().idx_dim(ensureHandle(this))
  }

  /** Effective storage bit width. */
  get bitWidth() {
    return loadBinding().idx_bit_width(ensureHandle(this))
  }

  /** Release filters and native index resources. This operation is idempotent. */
  dispose() {
    const handle = this[HANDLE]
    if (handle === null) {
      return
    }

    this.disposeFilters()
    loadBinding().idx_dispose(handle)
    this[HANDLE] = null
  }

  private disposeFilters() {
    for (const ref of this[FILTERS]) {
      ref.deref()?.dispose()
    }
    this[FILTERS].clear()
  }

  private pruneFilters() {
    for (const ref of this[FILTERS]) {
      if (ref.deref() === undefined) {
        this[FILTERS].delete(ref)
      }
    }
  }

  private validateBatch(name: string, vectors: Float32Array, ids: BigUint64Array) {
    if (!(vectors instanceof Float32Array)) {
      throw new TypeError(`${name}: vectors must be a Float32Array`)
    }
    if (!(ids instanceof BigUint64Array)) {
      throw new TypeError(`${name}: ids must be a BigUint64Array`)
    }
    if (vectors.length !== ids.length * this.dim) {
      throw new RangeError(
        `${name}: vectors.length (${vectors.length}) must equal ids.length (${ids.length}) * dim (${this.dim})`
      )
    }
  }

  private validateSearch(name: string, queries: Float32Array, k: number) {
    if (!(queries instanceof Float32Array)) {
      throw new TypeError(`${name}: queries must be a Float32Array`)
    }
    if (!isPositiveInt32(k)) {
      throw new TypeError(`${name}: k must be a positive int32`)
    }
  }

  private validateId(name: string, id: bigint) {
    if (typeof id !== 'bigint') {
      throw new TypeError(`${name}: id must be a bigint`)
    }
  }
}

export { IdMapIndex }

const cjsExports = IdMapIndex as typeof IdMapIndex & { default: typeof IdMapIndex }
cjsExports.default = IdMapIndex
cjsExports.IdMapIndex = IdMapIndex
cjsExports.IdMapIndexFilter = IdMapIndexFilter
module.exports = cjsExports
