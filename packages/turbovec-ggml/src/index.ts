const HANDLE = Symbol('IdMapIndex.handle')
const FILTER_HANDLE = Symbol('IdMapIndexFilter.handle')
const FILTER_OWNER = Symbol('IdMapIndexFilter.owner')
const FILTER_REF = Symbol('IdMapIndexFilter.ref')
const FILTERS = Symbol('IdMapIndex.filters')
const FILTERS_PRUNE_AT = Symbol('IdMapIndex.filtersPruneAt')
const QUEUE = Symbol('IdMapIndex.queue')
const PENDING = Symbol('IdMapIndex.pending')
const DIM = Symbol('IdMapIndex.dim')
const BIT_WIDTH = Symbol('IdMapIndex.bitWidth')
const INT32_MAX = 0x7fffffff
// Dropped filters leave dead WeakRefs behind. Pruning once the set doubles
// keeps prepareFilter amortized O(1) instead of rescanning on every call.
const MIN_FILTERS_PRUNE_AT = 64

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
  idx_create(options: { dim: number; storage: IdMapIndexStorage }): NativeHandle
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
  idx_calibrated(handle: NativeHandle): boolean
  idx_set_staged(handle: NativeHandle, enabled: boolean): void
  idx_staged(handle: NativeHandle): boolean
  idx_load_async(path: string): Promise<NativeHandle>
  idx_load_mmap_async(path: string): Promise<NativeHandle>
  idx_load_with_delta_async(snapshotPath: string, deltaPath: string): Promise<NativeHandle>
  idx_add_async(handle: NativeHandle, vectors: Float32Array, ids: BigUint64Array): Promise<void>
  idx_add_logged_async(
    handle: NativeHandle,
    vectors: Float32Array,
    ids: BigUint64Array,
    deltaPath: string
  ): Promise<void>
  idx_remove_async(handle: NativeHandle, id: bigint): Promise<boolean>
  idx_remove_logged_async(handle: NativeHandle, id: bigint, deltaPath: string): Promise<boolean>
  idx_search_async(
    handle: NativeHandle,
    queries: Float32Array,
    k: number
  ): Promise<IdMapIndexSearchResult>
  idx_search_filtered_async(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    allowedIds: BigUint64Array
  ): Promise<IdMapIndexSearchResult>
  idx_filter_create_async(handle: NativeHandle, allowedIds: BigUint64Array): Promise<NativeHandle>
  idx_search_prepared_filtered_async(
    handle: NativeHandle,
    filterHandle: NativeHandle,
    queries: Float32Array,
    k: number
  ): Promise<IdMapIndexSearchResult>
  idx_build_ivf_async(handle: NativeHandle, nLists: number, nIter: number): Promise<void>
  idx_search_ivf_async(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    nProbe: number
  ): Promise<IdMapIndexSearchResult>
  idx_compact_async(handle: NativeHandle): Promise<void>
  idx_prepare_async(handle: NativeHandle): Promise<void>
  idx_write_async(handle: NativeHandle, path: string): Promise<void>
  idx_compact_delta_async(
    handle: NativeHandle,
    snapshotPath: string,
    deltaPath: string
  ): Promise<void>
}

let binding: IdMapIndexBinding | undefined

function loadBinding() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- The native Bare binding is resolved lazily through CommonJS.
  binding ??= require('./binding') as IdMapIndexBinding
  return binding
}

function releaseFilter(owner: IdMapIndex, filter: IdMapIndexFilter) {
  const ref = filter[FILTER_REF]
  if (ref !== null) {
    owner[FILTERS].delete(ref)
  }
}

export type IdMapIndexBitWidth = 2 | 4 | 8 | 32
export type IdMapIndexStorage = keyof typeof BIT_WIDTH_BY_STORAGE

export interface IdMapIndexOptions {
  /**
   * Vector dimensionality. TurboVec requires a 64-bit target and a dimension
   * divisible by 8 and no greater than 16,384.
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

// Sync calls are rejected while async work is queued or running: fabric
// would block the JS thread on the index lock until that work finished, and
// the call would run out of order with it.
function ensureIdleHandle(index: IdMapIndex) {
  const handle = ensureHandle(index)
  if (index[PENDING] > 0) {
    throw new Error(
      'IdMapIndex has async operations in progress; await them before calling a sync method'
    )
  }
  return handle
}

function swallow() {}

// Calls `run` now; a synchronous throw becomes a rejection.
function startNow<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run())
  })
}

// Runs async operations on one index one at a time, in call order. On an
// idle index `run` starts now, so the native job holds the index before the
// caller's next statement (a `dispose()` right after lets it finish);
// otherwise it starts when every earlier operation has settled. The pending
// count drops before the caller's own continuation runs, so code that
// awaited the last operation can use the sync API straight away.
function enqueue<T>(index: IdMapIndex, run: () => Promise<T>): Promise<T> {
  ensureHandle(index)
  const result = index[PENDING] === 0 ? startNow(run) : index[QUEUE].then(run)
  index[PENDING] += 1
  const settled = () => {
    index[PENDING] -= 1
  }
  index[QUEUE] = result.then(settled, settled)
  return result
}

// Frees a native handle once the operations queued on `owner` have settled,
// or now when none are. An operation that is running holds the handle.
function releaseAfterQueue(owner: IdMapIndex, release: () => void) {
  if (owner[PENDING] === 0) {
    release()
    return
  }
  owner[QUEUE] = owner[QUEUE].then(release).then(swallow, swallow)
}

function normalizeStorageOptions(options: IdMapIndexOptions): IdMapIndexStorage {
  const { bitWidth, storage } = options

  if (storage !== undefined) {
    if (
      typeof storage !== 'string' ||
      !Object.prototype.hasOwnProperty.call(BIT_WIDTH_BY_STORAGE, storage)
    ) {
      throw new TypeError(
        "IdMapIndex: storage must be 'f32', 'q8', 'q4', 'turbovec-q4', or 'turbovec-q2'"
      )
    }
    // A null bitWidth counts as the default 8, as it did in embed-llamacpp.
    if (bitWidth !== undefined && (bitWidth ?? 8) !== BIT_WIDTH_BY_STORAGE[storage]) {
      throw new TypeError('IdMapIndex: bitWidth does not match storage')
    }
    return storage
  }

  const width = bitWidth ?? 8
  if (
    typeof width !== 'number' ||
    !Object.prototype.hasOwnProperty.call(STORAGE_BY_BIT_WIDTH, width)
  ) {
    throw new TypeError('IdMapIndex: bitWidth must be 2, 4, 8, or 32')
  }
  return STORAGE_BY_BIT_WIDTH[width]
}

export class IdMapIndexFilter {
  [FILTER_HANDLE]: NativeHandle | null = null;
  [FILTER_OWNER]: IdMapIndex | null = null;
  [FILTER_REF]: WeakRef<IdMapIndexFilter> | null = null

  private constructor() {
    throw new TypeError('IdMapIndexFilter instances must be created by IdMapIndex.prepareFilter()')
  }

  /** Search with this prepared allowlist. Mutating the owner invalidates the filter. */
  search(queries: Float32Array, k: number) {
    validateFilterSearch('IdMapIndexFilter.search', queries, k)
    const owner = this[FILTER_OWNER]
    const filterHandle = this[FILTER_HANDLE]
    if (owner === null || filterHandle === null) {
      throw new Error('IdMapIndexFilter has been disposed')
    }
    return loadBinding().idx_search_prepared_filtered(
      ensureIdleHandle(owner),
      filterHandle,
      queries,
      k
    )
  }

  /**
   * `search()` run off the JS thread, queued behind the owner's other async
   * operations. Rejects when a mutation queued before it disposed the filter.
   */
  async searchAsync(queries: Float32Array, k: number) {
    validateFilterSearch('IdMapIndexFilter.searchAsync', queries, k)
    const owner = this[FILTER_OWNER]
    if (owner === null || this[FILTER_HANDLE] === null) {
      throw new Error('IdMapIndexFilter has been disposed')
    }
    return enqueue(owner, () => {
      const filterHandle = this[FILTER_HANDLE]
      if (this[FILTER_OWNER] === null || filterHandle === null) {
        throw new Error('IdMapIndexFilter has been disposed')
      }
      return loadBinding().idx_search_prepared_filtered_async(
        ensureHandle(owner),
        filterHandle,
        queries,
        k
      )
    })
  }

  /**
   * Release the prepared native filter. This operation is idempotent. While
   * the owner has async operations queued, the native filter is freed after
   * they settle.
   */
  dispose() {
    const filterHandle = this[FILTER_HANDLE]
    if (filterHandle === null) {
      return
    }

    const owner = this[FILTER_OWNER]
    this[FILTER_HANDLE] = null
    this[FILTER_OWNER] = null
    if (owner !== null) {
      releaseFilter(owner, this)
      releaseAfterQueue(owner, () => loadBinding().idx_filter_dispose(filterHandle))
    } else {
      loadBinding().idx_filter_dispose(filterHandle)
    }
    this[FILTER_REF] = null
  }
}

function validateFilterSearch(name: string, queries: Float32Array, k: number) {
  if (!(queries instanceof Float32Array)) {
    throw new TypeError(`${name}: queries must be a Float32Array`)
  }
  if (!isPositiveInt32(k)) {
    throw new TypeError(`${name}: k must be a positive int32`)
  }
}

// A dropped filter needs no JS finalizer: its handle is a native external
// whose own finalizer frees the native filter once the handle is collected.
function createFilter(owner: IdMapIndex, handle: NativeHandle) {
  const filter = Object.create(IdMapIndexFilter.prototype) as IdMapIndexFilter
  filter[FILTER_OWNER] = owner
  filter[FILTER_HANDLE] = handle
  filter[FILTER_REF] = new WeakRef(filter)
  return filter
}

type IdMapIndexClass<T extends IdMapIndex> = (abstract new (...args: never[]) => T) & {
  prototype: T
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
  [FILTERS] = new Set<WeakRef<IdMapIndexFilter>>();
  [FILTERS_PRUNE_AT] = MIN_FILTERS_PRUNE_AT;
  [QUEUE]: Promise<unknown> = Promise.resolve();
  [PENDING] = 0;
  // Fixed for the life of the index. Kept in JS so validating an async call
  // never has to reach the native index while another call holds it.
  [DIM] = 0;
  [BIT_WIDTH]: IdMapIndexBitWidth = 8

  constructor(options: IdMapIndexOptions) {
    const { dim } = options ?? ({} as IdMapIndexOptions)
    if (!isPositiveInt32(dim)) {
      throw new TypeError('IdMapIndex: dim must be a positive int32')
    }
    const storage = normalizeStorageOptions(options)
    if (storage.startsWith('turbovec-') && (dim > 16_384 || dim % 8 !== 0)) {
      throw new RangeError(
        'IdMapIndex: TurboVec dim must be divisible by 8 and no greater than 16384'
      )
    }
    const handle = loadBinding().idx_create({ dim, storage })
    this[HANDLE] = handle
    this[DIM] = dim
    this[BIT_WIDTH] = loadBinding().idx_bit_width(handle)
  }

  /**
   * Load a v2/v3/v8 snapshot or migrate legacy v1 storage. Legacy bit-width 8
   * snapshots migrate to q8; other v1 widths migrate to f32. TurboVec v3
   * snapshots from earlier releases keep their encoding and keep writing v3;
   * those above 1,024 dimensions can be loaded and rewritten, but cannot add,
   * search, or build IVF state. Synchronous and potentially blocking.
   * Called on a subclass, returns an instance of that subclass; its
   * constructor and field initializers do not run.
   */
  static load<T extends IdMapIndex>(this: IdMapIndexClass<T>, path: string): T
  /** Detached call, e.g. `const { load } = IdMapIndex`. Returns an IdMapIndex. */
  static load(path: string): IdMapIndex
  static load(this: unknown, path: string): IdMapIndex {
    requireNonEmptyPath(path, 'IdMapIndex.load: path')
    return IdMapIndex.fromHandle(this, loadBinding().idx_load(path))
  }

  /**
   * Load a v2 snapshot with read-only mmap-backed vectors. Legacy v1 and
   * TurboVec (v3 and v8) snapshots are rejected. Requires a little-endian host
   * and, on POSIX, a filesystem supporting flock(). Mutations are rejected.
   * Returns a subclass instance when called on a subclass, as `load()` does.
   */
  static loadMmap<T extends IdMapIndex>(this: IdMapIndexClass<T>, path: string): T
  /** Detached call, e.g. `const { loadMmap } = IdMapIndex`. Returns an IdMapIndex. */
  static loadMmap(path: string): IdMapIndex
  static loadMmap(this: unknown, path: string): IdMapIndex {
    requireNonEmptyPath(path, 'IdMapIndex.loadMmap: path')
    return IdMapIndex.fromHandle(this, loadBinding().idx_load_mmap(path))
  }

  /**
   * Load a snapshot and replay its append-only delta log. A missing log is
   * treated as empty. The returned handle is bound to `deltaPath`; use logged
   * mutations and `compactDelta()` rather than plain mutations or `write()`.
   * Delta logs require a local filesystem with reliable cooperative locking.
   * TurboVec snapshots are rejected with `InvalidArgument`. Returns a
   * subclass instance when called on a subclass, as `load()` does.
   */
  static loadWithDelta<T extends IdMapIndex>(
    this: IdMapIndexClass<T>,
    snapshotPath: string,
    deltaPath: string
  ): T
  /** Detached call, e.g. `const { loadWithDelta } = IdMapIndex`. Returns an IdMapIndex. */
  static loadWithDelta(snapshotPath: string, deltaPath: string): IdMapIndex
  static loadWithDelta(this: unknown, snapshotPath: string, deltaPath: string): IdMapIndex {
    requireNonEmptyPath(snapshotPath, 'IdMapIndex.loadWithDelta: snapshotPath')
    requireNonEmptyPath(deltaPath, 'IdMapIndex.loadWithDelta: deltaPath')
    return IdMapIndex.fromHandle(this, loadBinding().idx_load_with_delta(snapshotPath, deltaPath))
  }

  // `ctor` is the class a loader was called on. A detached call such as
  // `const { load } = IdMapIndex` has no class, so it falls back to IdMapIndex.
  private static fromHandle(ctor: unknown, handle: NativeHandle) {
    const candidate: unknown = typeof ctor === 'function' ? ctor.prototype : undefined
    const isIndexPrototype = candidate === IdMapIndex.prototype || candidate instanceof IdMapIndex
    const prototype = isIndexPrototype ? candidate : IdMapIndex.prototype
    const instance = Object.create(prototype) as IdMapIndex
    instance[HANDLE] = handle
    instance[FILTERS] = new Set()
    instance[FILTERS_PRUNE_AT] = MIN_FILTERS_PRUNE_AT
    instance[QUEUE] = Promise.resolve()
    instance[PENDING] = 0
    instance[DIM] = loadBinding().idx_dim(handle)
    instance[BIT_WIDTH] = loadBinding().idx_bit_width(handle)
    return instance
  }

  /** `load()` run off the JS thread. */
  static loadAsync<T extends IdMapIndex>(this: IdMapIndexClass<T>, path: string): Promise<T>
  /** Detached call, e.g. `const { loadAsync } = IdMapIndex`. Resolves to an IdMapIndex. */
  static loadAsync(path: string): Promise<IdMapIndex>
  static async loadAsync(this: unknown, path: string): Promise<IdMapIndex> {
    requireNonEmptyPath(path, 'IdMapIndex.loadAsync: path')
    return IdMapIndex.fromHandle(this, await loadBinding().idx_load_async(path))
  }

  /** `loadMmap()` run off the JS thread. */
  static loadMmapAsync<T extends IdMapIndex>(this: IdMapIndexClass<T>, path: string): Promise<T>
  /** Detached call, e.g. `const { loadMmapAsync } = IdMapIndex`. Resolves to an IdMapIndex. */
  static loadMmapAsync(path: string): Promise<IdMapIndex>
  static async loadMmapAsync(this: unknown, path: string): Promise<IdMapIndex> {
    requireNonEmptyPath(path, 'IdMapIndex.loadMmapAsync: path')
    return IdMapIndex.fromHandle(this, await loadBinding().idx_load_mmap_async(path))
  }

  /** `loadWithDelta()` run off the JS thread. */
  static loadWithDeltaAsync<T extends IdMapIndex>(
    this: IdMapIndexClass<T>,
    snapshotPath: string,
    deltaPath: string
  ): Promise<T>
  /** Detached call, e.g. `const { loadWithDeltaAsync } = IdMapIndex`. Resolves to an IdMapIndex. */
  static loadWithDeltaAsync(snapshotPath: string, deltaPath: string): Promise<IdMapIndex>
  static async loadWithDeltaAsync(
    this: unknown,
    snapshotPath: string,
    deltaPath: string
  ): Promise<IdMapIndex> {
    requireNonEmptyPath(snapshotPath, 'IdMapIndex.loadWithDeltaAsync: snapshotPath')
    requireNonEmptyPath(deltaPath, 'IdMapIndex.loadWithDeltaAsync: deltaPath')
    return IdMapIndex.fromHandle(
      this,
      await loadBinding().idx_load_with_delta_async(snapshotPath, deltaPath)
    )
  }

  /**
   * Atomically add vectors with stable uint64 IDs. `vectors` is row-major and
   * must contain `ids.length * dim` finite components. TurboVec additionally
   * requires `abs(component) < 1e16`. UINT64_MAX is reserved.
   */
  addWithIds(vectors: Float32Array, ids: BigUint64Array) {
    this.validateBatch('addWithIds', vectors, ids)
    const handle = ensureIdleHandle(this)
    try {
      loadBinding().idx_add(handle, vectors, ids)
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
    const handle = ensureIdleHandle(this)
    try {
      loadBinding().idx_add_logged(handle, vectors, ids, deltaPath)
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
    return loadBinding().idx_search(ensureIdleHandle(this), queries, k)
  }

  /** Exact search restricted to the supplied external IDs. */
  searchFiltered(queries: Float32Array, k: number, allowedIds: BigUint64Array) {
    this.validateSearch('searchFiltered', queries, k)
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError('searchFiltered: allowedIds must be a BigUint64Array')
    }
    return loadBinding().idx_search_filtered(ensureIdleHandle(this), queries, k, allowedIds)
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
    return this.registerFilter(loadBinding().idx_filter_create(ensureIdleHandle(this), allowedIds))
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
    loadBinding().idx_build_ivf(ensureIdleHandle(this), nLists, nIter)
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
    return loadBinding().idx_search_ivf(ensureIdleHandle(this), queries, k, nProbe)
  }

  /** Remove an ID, returning false when it is not present. */
  remove(id: bigint) {
    this.validateId('remove', id)
    const removed = loadBinding().idx_remove(ensureIdleHandle(this), id)
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
    const handle = ensureIdleHandle(this)
    try {
      return loadBinding().idx_remove_logged(handle, id, deltaPath)
    } finally {
      this.disposeFilters()
    }
  }

  /** Physically reclaim tombstoned slots. Rejected on delta-bound handles. */
  compact() {
    const handle = ensureIdleHandle(this)
    try {
      loadBinding().idx_compact(handle)
    } finally {
      this.disposeFilters()
    }
  }

  /** Return whether the index contains an external ID. */
  contains(id: bigint) {
    this.validateId('contains', id)
    return loadBinding().idx_contains(ensureIdleHandle(this), id)
  }

  /** Best-effort warmup of TurboVec rotation and codebook state. */
  prepare() {
    loadBinding().idx_prepare(ensureIdleHandle(this))
  }

  /**
   * Persist a checksummed v2 snapshot for f32/q4/q8, or a v8 snapshot for
   * TurboVec (v3 for an index loaded from a v3 snapshot). Delta-bound handles
   * must use `compactDelta()`. A NotDurable error means replacement succeeded
   * but parent-directory durability was not confirmed.
   */
  write(path: string) {
    requireNonEmptyPath(path, 'write: path')
    loadBinding().idx_write(ensureIdleHandle(this), path)
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
    const handle = ensureIdleHandle(this)
    try {
      loadBinding().idx_compact_delta(handle, snapshotPath, deltaPath)
    } finally {
      this.disposeFilters()
    }
  }

  // -------------------------------------------------------------------------
  // Async API
  //
  // Each method runs its sync twin's native work off the JS thread and
  // resolves with the same value, or rejects with the same error. Async
  // operations on one index run one at a time, in call order, so a search
  // queued after an add sees that add. Across indexes, long work (adds,
  // builds, loads, writes, compaction) and searches run on two separate
  // native worker threads, so a long build never holds up a search. While any
  // async operation is queued or running, sync methods and the `length`,
  // `calibrated` and `stagedSearch` getters throw; `dim`, `bitWidth` and
  // `dispose()` still work. Input arrays are copied when the call is made.
  // -------------------------------------------------------------------------

  /** `addWithIds()` run off the JS thread. */
  async addWithIdsAsync(vectors: Float32Array, ids: BigUint64Array) {
    this.validateBatch('addWithIdsAsync', vectors, ids)
    return enqueue(this, () =>
      this.mutate(() => loadBinding().idx_add_async(ensureHandle(this), vectors, ids))
    )
  }

  /** `addLogged()` run off the JS thread. */
  async addLoggedAsync(vectors: Float32Array, ids: BigUint64Array, deltaPath: string) {
    this.validateBatch('addLoggedAsync', vectors, ids)
    requireNonEmptyPath(deltaPath, 'addLoggedAsync: deltaPath')
    return enqueue(this, () =>
      this.mutate(() =>
        loadBinding().idx_add_logged_async(ensureHandle(this), vectors, ids, deltaPath)
      )
    )
  }

  /** `search()` run off the JS thread. */
  async searchAsync(queries: Float32Array, k: number) {
    this.validateSearch('searchAsync', queries, k)
    return enqueue(this, () => loadBinding().idx_search_async(ensureHandle(this), queries, k))
  }

  /** `searchFiltered()` run off the JS thread. */
  async searchFilteredAsync(queries: Float32Array, k: number, allowedIds: BigUint64Array) {
    this.validateSearch('searchFilteredAsync', queries, k)
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError('searchFilteredAsync: allowedIds must be a BigUint64Array')
    }
    return enqueue(this, () =>
      loadBinding().idx_search_filtered_async(ensureHandle(this), queries, k, allowedIds)
    )
  }

  /** `prepareFilter()` run off the JS thread. */
  async prepareFilterAsync(allowedIds: BigUint64Array) {
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError('prepareFilterAsync: allowedIds must be a BigUint64Array')
    }
    return enqueue(this, async () => {
      const filterHandle = await loadBinding().idx_filter_create_async(
        ensureHandle(this),
        allowedIds
      )
      // dispose() ran while the filter was being built. Free the filter now,
      // while the index is still alive: fabric requires the index to outlive
      // its filters, and the index is freed once this operation settles.
      if (this[HANDLE] === null) {
        loadBinding().idx_filter_dispose(filterHandle)
        throw new Error('IdMapIndex has been disposed')
      }
      return this.registerFilter(filterHandle)
    })
  }

  /**
   * `buildIvf()` run off the JS thread. The build cannot be cancelled: once
   * it starts, it runs to the end.
   */
  async buildIvfAsync(nLists: number, nIter = 0) {
    if (!isPositiveInt32(nLists)) {
      throw new TypeError('buildIvfAsync: nLists must be a positive int32')
    }
    if (!isNonNegativeInt32(nIter)) {
      throw new TypeError('buildIvfAsync: nIter must be a non-negative int32')
    }
    return enqueue(this, () => loadBinding().idx_build_ivf_async(ensureHandle(this), nLists, nIter))
  }

  /** `searchIvf()` run off the JS thread. */
  async searchIvfAsync(queries: Float32Array, k: number, nProbe: number) {
    this.validateSearch('searchIvfAsync', queries, k)
    if (!isPositiveInt32(nProbe)) {
      throw new TypeError('searchIvfAsync: nProbe must be a positive int32')
    }
    return enqueue(this, () =>
      loadBinding().idx_search_ivf_async(ensureHandle(this), queries, k, nProbe)
    )
  }

  /** `remove()` run off the JS thread. */
  async removeAsync(id: bigint) {
    this.validateId('removeAsync', id)
    return enqueue(this, async () => {
      const removed = await loadBinding().idx_remove_async(ensureHandle(this), id)
      if (removed) {
        this.disposeFilters()
      }
      return removed
    })
  }

  /** `removeLogged()` run off the JS thread. */
  async removeLoggedAsync(id: bigint, deltaPath: string) {
    this.validateId('removeLoggedAsync', id)
    requireNonEmptyPath(deltaPath, 'removeLoggedAsync: deltaPath')
    return enqueue(this, () =>
      this.mutate(() => loadBinding().idx_remove_logged_async(ensureHandle(this), id, deltaPath))
    )
  }

  /** `compact()` run off the JS thread. */
  async compactAsync() {
    return enqueue(this, () =>
      this.mutate(() => loadBinding().idx_compact_async(ensureHandle(this)))
    )
  }

  /** `prepare()` run off the JS thread. */
  async prepareAsync() {
    return enqueue(this, () => loadBinding().idx_prepare_async(ensureHandle(this)))
  }

  /** `write()` run off the JS thread. */
  async writeAsync(path: string) {
    requireNonEmptyPath(path, 'writeAsync: path')
    return enqueue(this, () => loadBinding().idx_write_async(ensureHandle(this), path))
  }

  /** `compactDelta()` run off the JS thread. */
  async compactDeltaAsync(snapshotPath: string, deltaPath: string) {
    requireNonEmptyPath(snapshotPath, 'compactDeltaAsync: snapshotPath')
    requireNonEmptyPath(deltaPath, 'compactDeltaAsync: deltaPath')
    return enqueue(this, () =>
      this.mutate(() =>
        loadBinding().idx_compact_delta_async(ensureHandle(this), snapshotPath, deltaPath)
      )
    )
  }

  /** Number of live entries. */
  get length() {
    return loadBinding().idx_len(ensureIdleHandle(this))
  }

  /** Vector dimensionality. */
  get dim() {
    ensureHandle(this)
    return this[DIM]
  }

  /** Effective storage bit width. */
  get bitWidth() {
    ensureHandle(this)
    return this[BIT_WIDTH]
  }

  /**
   * Whether a TurboVec index holds a TQ+ calibration. A fresh TurboVec index
   * calibrates from its first `addWithIds()` batch when that batch has at
   * least 1,000 rows; other storages are never calibrated.
   */
  get calibrated() {
    return loadBinding().idx_calibrated(ensureIdleHandle(this))
  }

  /**
   * Whether staged search is turned on. Off for every new or loaded index.
   * Reports the setting, not whether a search runs in stages: see
   * `setStagedSearch()`.
   */
  get stagedSearch() {
    return loadBinding().idx_staged(ensureIdleHandle(this))
  }

  /**
   * Turn TurboVec staged search on or off. On, a search of 32,768 or more
   * vectors scans a compressed form first and scores only a shortlist: several
   * times faster per query, but it can miss some of the best matches,
   * especially at small k. It applies only at a dimension divisible by 32, on
   * hosts that support it, and never to an index loaded from a v3 snapshot;
   * elsewhere the setting is kept but every search scans in full. Throws for
   * non-TurboVec storage. Not saved in snapshots.
   */
  setStagedSearch(enabled: boolean) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('setStagedSearch: enabled must be a boolean')
    }
    loadBinding().idx_set_staged(ensureIdleHandle(this), enabled)
  }

  /**
   * Release filters and native index resources. This operation is
   * idempotent. Async operations that have not started yet reject; one that
   * is running finishes first, and the native index is freed after it.
   */
  dispose() {
    const handle = this[HANDLE]
    if (handle === null) {
      return
    }

    this.disposeFilters()
    this[HANDLE] = null
    releaseAfterQueue(this, () => loadBinding().idx_dispose(handle))
  }

  /** `dispose()`, resolving once the native index has been freed. */
  async disposeAsync() {
    this.dispose()
    await this[QUEUE]
  }

  private disposeFilters() {
    for (const ref of this[FILTERS]) {
      ref.deref()?.dispose()
    }
    this[FILTERS].clear()
  }

  // Runs a native mutation, then invalidates prepared filters whether or not
  // it succeeded, as the sync mutations do.
  private async mutate<T>(start: () => Promise<T>) {
    try {
      return await start()
    } finally {
      this.disposeFilters()
    }
  }

  private registerFilter(handle: NativeHandle) {
    const filter = createFilter(this, handle)
    this[FILTERS].add(filter[FILTER_REF] as WeakRef<IdMapIndexFilter>)
    if (this[FILTERS].size >= this[FILTERS_PRUNE_AT]) {
      this.pruneFilters()
      this[FILTERS_PRUNE_AT] = Math.max(MIN_FILTERS_PRUNE_AT, this[FILTERS].size * 2)
    }
    return filter
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
