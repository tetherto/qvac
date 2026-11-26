const HANDLE = Symbol('IdMapIndex.handle')
const FILTER_HANDLE = Symbol('IdMapIndexFilter.handle')
const FILTER_OWNER = Symbol('IdMapIndexFilter.owner')
const FILTER_REF = Symbol('IdMapIndexFilter.ref')
const FILTER_RELEASED = Symbol('IdMapIndexFilter.released')
const FILTERS = Symbol('IdMapIndex.filters')
const FILTERS_PRUNE_AT = Symbol('IdMapIndex.filtersPruneAt')
const QUEUE = Symbol('IdMapIndex.queue')
const PENDING = Symbol('IdMapIndex.pending')
const DIM = Symbol('IdMapIndex.dim')
const BIT_WIDTH = Symbol('IdMapIndex.bitWidth')
const LENGTH = Symbol('IdMapIndex.length')
const CALIBRATED = Symbol('IdMapIndex.calibrated')
const STAGED = Symbol('IdMapIndex.staged')
const THREADS = Symbol('IdMapIndex.threads')
const STORAGE = Symbol('IdMapIndex.storage')
const LEGACY = Symbol('IdMapIndex.legacy')
const SERIALIZED_SIZE = Symbol('IdMapIndex.serializedSize')
const INT32_MAX = 0x7fffffff
// Fabric's limit for ggml_vec_index_set_threads.
const MAX_THREADS = 256
// Dropped filters leave dead WeakRefs behind. Pruning once the set doubles
// keeps prepareFilter amortized O(1) instead of rescanning on every call.
const MIN_FILTERS_PRUNE_AT = 64

const BIT_WIDTH_BY_STORAGE = {
  f32: 32,
  q8: 8,
  q4: 4,
  'turbovec-q4': 4,
  'turbovec-q3': 3,
  'turbovec-q2': 2
} as const

const STORAGE_BY_BIT_WIDTH = {
  2: 'turbovec-q2',
  3: 'turbovec-q3',
  4: 'q4',
  8: 'q8',
  32: 'f32'
} as const

type NativeHandle = object
// Set when a call's AbortSignal aborts. The native job checks it as it
// starts, so a call aborted while it waits on a worker thread is skipped.
type AbortToken = object
type Token = AbortToken | undefined

// Every call that reads or changes the native index returns a promise and
// runs on a worker thread owned by the addon. The few sync calls here are
// cheap reads and frees that the JS wrapper makes only while no worker holds
// the index. Each async call takes the call's abort token after its own
// arguments, and those with array inputs a `borrow` flag after that: true
// when the arrays are this wrapper's own private copies (see snapshot()),
// which the native call then keeps instead of copying again.
interface IdMapIndexBinding {
  idx_create(options: { dim: number; storage: IdMapIndexStorage }): NativeHandle
  idx_contains(handle: NativeHandle, id: bigint): boolean
  idx_dispose(handle: NativeHandle): void
  idx_filter_dispose(handle: NativeHandle): void
  idx_len(handle: NativeHandle): number
  idx_dim(handle: NativeHandle): number
  idx_bit_width(handle: NativeHandle): IdMapIndexBitWidth
  idx_calibrated(handle: NativeHandle): boolean
  idx_staged(handle: NativeHandle): boolean
  idx_threads(handle: NativeHandle): number
  idx_set_threads(handle: NativeHandle, nThreads: number): void
  idx_storage(handle: NativeHandle): IdMapIndexStorage
  idx_legacy(handle: NativeHandle): boolean
  idx_serialized_size(handle: NativeHandle): number
  idx_abort_token_create(): AbortToken
  idx_abort_token_abort(token: AbortToken): void
  idx_load_async(path: string, token: Token): Promise<NativeHandle>
  idx_load_mmap_async(path: string, token: Token): Promise<NativeHandle>
  idx_load_with_delta_async(
    snapshotPath: string,
    deltaPath: string,
    token: Token
  ): Promise<NativeHandle>
  idx_from_bytes_async(bytes: Uint8Array, token: Token): Promise<NativeHandle>
  idx_add_async(
    handle: NativeHandle,
    vectors: Float32Array,
    ids: BigUint64Array,
    token: Token,
    borrow: boolean
  ): Promise<void>
  idx_add_logged_async(
    handle: NativeHandle,
    vectors: Float32Array,
    ids: BigUint64Array,
    deltaPath: string,
    token: Token,
    borrow: boolean
  ): Promise<void>
  idx_remove_async(handle: NativeHandle, id: bigint, token: Token): Promise<boolean>
  idx_remove_logged_async(
    handle: NativeHandle,
    id: bigint,
    deltaPath: string,
    token: Token
  ): Promise<boolean>
  idx_search_async(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    token: Token,
    borrow: boolean
  ): Promise<IdMapIndexSearchResult>
  idx_search_filtered_async(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    allowedIds: BigUint64Array,
    token: Token,
    borrow: boolean
  ): Promise<IdMapIndexSearchResult>
  idx_filter_create_async(
    handle: NativeHandle,
    allowedIds: BigUint64Array,
    token: Token,
    borrow: boolean
  ): Promise<NativeHandle>
  idx_search_prepared_filtered_async(
    handle: NativeHandle,
    filterHandle: NativeHandle,
    queries: Float32Array,
    k: number,
    token: Token,
    borrow: boolean
  ): Promise<IdMapIndexSearchResult>
  idx_set_staged_async(handle: NativeHandle, enabled: boolean, token: Token): Promise<void>
  idx_build_ivf_async(
    handle: NativeHandle,
    nLists: number,
    nIter: number,
    token: Token
  ): Promise<void>
  idx_search_ivf_async(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    nProbe: number,
    token: Token,
    borrow: boolean
  ): Promise<IdMapIndexSearchResult>
  idx_compact_async(handle: NativeHandle, token: Token): Promise<void>
  idx_prepare_async(handle: NativeHandle, token: Token): Promise<void>
  idx_write_async(handle: NativeHandle, path: string, fast: boolean, token: Token): Promise<void>
  idx_sync_async(handle: NativeHandle, path: string, token: Token): Promise<void>
  idx_ids_async(handle: NativeHandle, token: Token): Promise<BigUint64Array>
  idx_to_bytes_async(handle: NativeHandle, token: Token): Promise<Uint8Array>
  idx_compact_delta_async(
    handle: NativeHandle,
    snapshotPath: string,
    deltaPath: string,
    token: Token
  ): Promise<void>
}

let binding: IdMapIndexBinding | undefined

function loadBinding() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- The native Bare binding is resolved lazily through CommonJS.
  binding ??= require('./binding') as IdMapIndexBinding
  return binding
}

export type IdMapIndexBitWidth = 2 | 3 | 4 | 8 | 32
export type IdMapIndexStorage = keyof typeof BIT_WIDTH_BY_STORAGE

export interface IdMapIndexOptions {
  /**
   * Vector dimensionality. TurboVec requires a 64-bit target and a dimension
   * divisible by 8 and no greater than 16,384.
   */
  dim: number
  /**
   * 2 = TurboVec q2, 3 = TurboVec q3, 4 = q4, 8 = q8, and 32 = full f32
   * storage. Defaults to 8.
   */
  bitWidth?: IdMapIndexBitWidth
  /** Use `turbovec-q4` to distinguish TurboVec q4 from generic q4 storage. */
  storage?: IdMapIndexStorage
  /** Worker threads for the index's calls; see `setThreads()`. Defaults to 1. */
  threads?: number
}

/**
 * The parts of an `AbortSignal` the index uses. Signals from the DOM, Node
 * and `bare-abort-controller` all fit.
 */
export interface IdMapIndexAbortSignal {
  readonly aborted: boolean
  readonly reason?: unknown
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export interface IdMapIndexCallOptions {
  /**
   * Cancels the call. A call that has not started is skipped. A call that is
   * running rejects at once, but its native work runs to the end: a search's
   * result is dropped, while a mutation such as `addWithIds()` or
   * `buildIvf()` still takes effect. Later calls on the index wait for that
   * work. The promise rejects with `signal.reason`.
   */
  signal?: IdMapIndexAbortSignal
}

export interface IdMapIndexWriteOptions extends IdMapIndexCallOptions {
  /**
   * `durable` (the default) fsyncs the snapshot and its directory before
   * resolving. `fast` skips both fsyncs: the file is still replaced
   * atomically and survives a process crash, but a power loss soon after
   * may lose it, and a delta log cannot start from it.
   */
  durability?: 'durable' | 'fast'
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

function requireThreads(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_THREADS) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_THREADS}`)
  }
}

function readWriteFast(options: IdMapIndexWriteOptions | undefined) {
  const durability = options?.durability
  if (durability === undefined || durability === 'durable') {
    return false
  }
  if (durability === 'fast') {
    return true
  }
  throw new TypeError("write: options.durability must be 'durable' or 'fast'")
}

function requireNonEmptyPath(value: string, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

function readSignal(name: string, options: IdMapIndexCallOptions | undefined) {
  if (options === undefined) {
    return undefined
  }
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${name}: options must be an object`)
  }
  const { signal } = options
  if (signal === undefined) {
    return undefined
  }
  if (
    signal === null ||
    typeof signal !== 'object' ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw new TypeError(`${name}: options.signal must be an AbortSignal`)
  }
  return signal
}

// The caller's own reason, passed through as fetch() does: an AbortError or
// TimeoutError unless they aborted with something else. Typed as Error for
// the code that throws it.
function abortReason(signal: IdMapIndexAbortSignal): Error {
  if (signal.reason !== undefined) {
    return signal.reason as Error
  }
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function ensureHandle(index: IdMapIndex) {
  const handle = index[HANDLE]
  if (handle === null) {
    throw new Error('IdMapIndex has been disposed')
  }
  return handle
}

function swallow() {}

// Calls `run` now; a synchronous throw becomes a rejection.
function startNow<T>(run: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run())
  })
}

// The abort token for a call with `signal`, or undefined without one.
function abortToken(signal: IdMapIndexAbortSignal | undefined): Token {
  return signal === undefined ? undefined : loadBinding().idx_abort_token_create()
}

// Rejects with the signal's reason once it aborts, without waiting for
// `result`, and sets `token`, so a native job that has not started yet is
// skipped. A value `result` still produces after that is passed to
// `discard`, so resources such as a loaded index or a prepared filter are
// freed.
function raceAbort<T>(
  result: Promise<T>,
  signal: IdMapIndexAbortSignal,
  token: AbortToken,
  discard?: (value: T) => unknown
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      loadBinding().idx_abort_token_abort(token)
      reject(abortReason(signal))
      result.then(discard ?? swallow, swallow)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    result.finally(() => signal.removeEventListener('abort', onAbort)).then(resolve, reject)
  })
}

// Runs operations on one index one at a time, in call order. Each runs once
// every earlier operation, and every native free queued before it, has
// settled, so `run` always finds no worker holding the index. On an idle
// index `run` starts now, so the native job holds the index before the
// caller's next statement (a `dispose()` right after lets it finish). An
// operation whose signal aborts while it waits, here or on a worker thread,
// is skipped. `run` gets the call's abort token to pass to the native call.
function enqueue<T>(
  index: IdMapIndex,
  run: (token: Token) => T | Promise<T>,
  signal: IdMapIndexAbortSignal | undefined,
  discard?: (value: T) => unknown
): Promise<T> {
  ensureHandle(index)
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal))
  }
  const token = abortToken(signal)
  const guarded = () => {
    if (signal?.aborted) {
      throw abortReason(signal)
    }
    return run(token)
  }
  const result = index[PENDING] === 0 ? startNow(guarded) : index[QUEUE].then(guarded)
  index[PENDING] += 1
  const settled = () => {
    index[PENDING] -= 1
  }
  index[QUEUE] = result.then(settled, settled)
  return signal === undefined || token === undefined
    ? result
    : raceAbort(result, signal, token, discard)
}

// Whether a call made now waits behind earlier ones. The native call takes
// its array inputs when it starts; a call that waits starts later, so its
// inputs are copied here, at call time, by snapshot(): the caller may change
// or transfer them once the call returns. The native call then keeps those
// private copies instead of copying them again (the binding's `borrow`).
// Must be read in the same synchronous step as the `enqueue()` it feeds.
function waitsInQueue(index: IdMapIndex) {
  return index[PENDING] !== 0
}

function snapshot<T extends Float32Array | BigUint64Array>(index: IdMapIndex, array: T): T {
  return waitsInQueue(index) ? (array.slice() as T) : array
}

// Frees a native handle once everything queued on `owner` has settled, or
// now when nothing is. A queued free counts as pending work until it has
// run, so a later free, such as the index's own, always runs after it. The
// returned promise rejects when the free throws.
function releaseAfterQueue(owner: IdMapIndex, release: () => void): Promise<void> {
  if (owner[PENDING] === 0) {
    return startNow(release)
  }
  owner[PENDING] += 1
  const done = () => {
    owner[PENDING] -= 1
  }
  const released = owner[QUEUE].then(release)
  owner[QUEUE] = released.then(done, done)
  return released
}

function normalizeStorageOptions(options: IdMapIndexOptions): IdMapIndexStorage {
  const { bitWidth, storage } = options

  if (storage !== undefined) {
    if (
      typeof storage !== 'string' ||
      !Object.prototype.hasOwnProperty.call(BIT_WIDTH_BY_STORAGE, storage)
    ) {
      throw new TypeError(
        "IdMapIndex: storage must be 'f32', 'q8', 'q4', 'turbovec-q4', 'turbovec-q3', or 'turbovec-q2'"
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
    throw new TypeError('IdMapIndex: bitWidth must be 2, 3, 4, 8, or 32')
  }
  return STORAGE_BY_BIT_WIDTH[width]
}

// Unlinks a filter from its owner and returns its native handle, or null
// when it was already disposed.
function detachFilter(filter: IdMapIndexFilter) {
  const filterHandle = filter[FILTER_HANDLE]
  if (filterHandle === null) {
    return null
  }
  const owner = filter[FILTER_OWNER]
  const ref = filter[FILTER_REF]
  if (owner !== null && ref !== null) {
    owner[FILTERS].delete(ref)
  }
  filter[FILTER_HANDLE] = null
  filter[FILTER_OWNER] = null
  filter[FILTER_REF] = null
  return { filterHandle, owner }
}

export class IdMapIndexFilter {
  [FILTER_HANDLE]: NativeHandle | null = null;
  [FILTER_OWNER]: IdMapIndex | null = null;
  [FILTER_REF]: WeakRef<IdMapIndexFilter> | null = null;
  // Settles once the native filter has been freed. Already resolved when the
  // owner freed it at a turn in its queue, which happens as it is detached.
  [FILTER_RELEASED]: Promise<void> = Promise.resolve()

  private constructor() {
    throw new TypeError('IdMapIndexFilter instances must be created by IdMapIndex.prepareFilter()')
  }

  /**
   * Search with this prepared allowlist, queued behind the owner's other
   * operations. Rejects when an earlier mutation of the owner disposed the
   * filter: every mutation invalidates the owner's filters.
   */
  async search(queries: Float32Array, k: number, options?: IdMapIndexCallOptions) {
    validateFilterSearch('IdMapIndexFilter.search', queries, k)
    const signal = readSignal('IdMapIndexFilter.search', options)
    const owner = this[FILTER_OWNER]
    if (owner === null || this[FILTER_HANDLE] === null) {
      throw new Error('IdMapIndexFilter has been disposed')
    }
    const borrow = waitsInQueue(owner)
    const input = snapshot(owner, queries)
    return enqueue(
      owner,
      (token) => {
        const filterHandle = this[FILTER_HANDLE]
        if (this[FILTER_OWNER] === null || filterHandle === null) {
          throw new Error('IdMapIndexFilter has been disposed')
        }
        return loadBinding().idx_search_prepared_filtered_async(
          ensureHandle(owner),
          filterHandle,
          input,
          k,
          token,
          borrow
        )
      },
      signal
    )
  }

  /**
   * Release the prepared native filter. The filter cannot be used after this
   * call. While the owner has operations queued, the native filter is freed
   * after they settle. Resolves once the native filter has been freed, and
   * rejects if freeing it fails. This operation is idempotent: a later call
   * returns the same promise.
   */
  dispose(): Promise<void> {
    const detached = detachFilter(this)
    if (detached === null) {
      return this[FILTER_RELEASED]
    }
    const { filterHandle, owner } = detached
    const release = () => loadBinding().idx_filter_dispose(filterHandle)
    this[FILTER_RELEASED] = owner === null ? startNow(release) : releaseAfterQueue(owner, release)
    return this[FILTER_RELEASED]
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
  // Object.create() skips the class's field initializers.
  filter[FILTER_RELEASED] = Promise.resolve()
  return filter
}

type IdMapIndexClass<T extends IdMapIndex> = (abstract new (...args: never[]) => T) & {
  prototype: T
}

function disposeIndex(index: IdMapIndex) {
  return index.dispose()
}

/**
 * CPU vector index with fixed dimensionality and stable uint64 external IDs.
 * Search uses exact or approximate dot products depending on storage. Callers
 * wanting cosine similarity should L2-normalize vectors before insertion and
 * queries before search. TurboVec normalizes indexed vectors while quantizing,
 * then restores their magnitude with a per-vector scale; it does not normalize
 * queries.
 *
 * Every method that reads or changes the index returns a promise and runs
 * its native work on a worker thread owned by the addon, so the JS thread
 * stays free. Calls on one index run one at a time, in call order, so a
 * search made after an add sees that add. Across indexes, long work (adds,
 * builds, loads, writes, compaction, filter preparation) and searches run on
 * two separate worker threads, so a long build never holds up a search. Input
 * arrays are copied
 * when the call is made. Each call takes an optional `{ signal }`: see
 * {@link IdMapIndexCallOptions}.
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
  // Kept in JS so the getters never reach the native index while a worker
  // holds it. `dim` and `bitWidth` are fixed; the rest are read again after
  // each call that can change them.
  [DIM] = 0;
  [BIT_WIDTH]: IdMapIndexBitWidth = 8;
  [LENGTH] = 0;
  [CALIBRATED] = false;
  [STAGED] = false;
  [THREADS] = 1;
  [STORAGE]: IdMapIndexStorage = 'q8';
  [LEGACY] = false;
  [SERIALIZED_SIZE] = 0

  constructor(options: IdMapIndexOptions) {
    const { dim, threads } = options ?? ({} as IdMapIndexOptions)
    if (!isPositiveInt32(dim)) {
      throw new TypeError('IdMapIndex: dim must be a positive int32')
    }
    const storage = normalizeStorageOptions(options)
    if (storage.startsWith('turbovec-') && (dim > 16_384 || dim % 8 !== 0)) {
      throw new RangeError(
        'IdMapIndex: TurboVec dim must be divisible by 8 and no greater than 16384'
      )
    }
    if (threads !== undefined) {
      requireThreads(threads, 'IdMapIndex: threads')
    }
    const native = loadBinding()
    const handle = native.idx_create({ dim, storage })
    this[HANDLE] = handle
    if (threads !== undefined) {
      native.idx_set_threads(handle, threads)
    }
    this.readState()
  }

  /**
   * Load a v2/v3/v8 snapshot or migrate legacy v1 storage. Legacy bit-width 8
   * snapshots migrate to q8; other v1 widths migrate to f32. TurboVec v3
   * snapshots from earlier releases keep their encoding and keep writing v3;
   * those above 1,024 dimensions can be loaded and rewritten, but cannot add,
   * search, or build IVF state. Called on a subclass, resolves to an instance
   * of that subclass; its constructor and field initializers do not run. An
   * index that finishes loading after `signal` aborts is disposed.
   */
  static load<T extends IdMapIndex>(
    this: IdMapIndexClass<T>,
    path: string,
    options?: IdMapIndexCallOptions
  ): Promise<T>
  /** Detached call, e.g. `const { load } = IdMapIndex`. Resolves to an IdMapIndex. */
  static load(path: string, options?: IdMapIndexCallOptions): Promise<IdMapIndex>
  static async load(
    this: unknown,
    path: string,
    options?: IdMapIndexCallOptions
  ): Promise<IdMapIndex> {
    requireNonEmptyPath(path, 'IdMapIndex.load: path')
    const signal = readSignal('IdMapIndex.load', options)
    return IdMapIndex.startLoad(this, signal, (token) => loadBinding().idx_load_async(path, token))
  }

  /**
   * Load a v2 snapshot with read-only mmap-backed vectors. Legacy v1 and
   * TurboVec (v3 and v8) snapshots are rejected. Requires a little-endian host
   * and, on POSIX, a filesystem supporting flock(). Mutations are rejected.
   * Resolves to a subclass instance when called on a subclass, as `load()`
   * does.
   */
  static loadMmap<T extends IdMapIndex>(
    this: IdMapIndexClass<T>,
    path: string,
    options?: IdMapIndexCallOptions
  ): Promise<T>
  /** Detached call, e.g. `const { loadMmap } = IdMapIndex`. Resolves to an IdMapIndex. */
  static loadMmap(path: string, options?: IdMapIndexCallOptions): Promise<IdMapIndex>
  static async loadMmap(
    this: unknown,
    path: string,
    options?: IdMapIndexCallOptions
  ): Promise<IdMapIndex> {
    requireNonEmptyPath(path, 'IdMapIndex.loadMmap: path')
    const signal = readSignal('IdMapIndex.loadMmap', options)
    return IdMapIndex.startLoad(this, signal, (token) =>
      loadBinding().idx_load_mmap_async(path, token)
    )
  }

  /**
   * Load a snapshot and replay its append-only delta log. A missing log is
   * treated as empty. The returned index is bound to `deltaPath`; use logged
   * mutations and `compactDelta()` rather than plain mutations or `write()`.
   * Delta logs require a local filesystem with reliable cooperative locking.
   * TurboVec snapshots are rejected with `InvalidArgument`. Resolves to a
   * subclass instance when called on a subclass, as `load()` does.
   */
  static loadWithDelta<T extends IdMapIndex>(
    this: IdMapIndexClass<T>,
    snapshotPath: string,
    deltaPath: string,
    options?: IdMapIndexCallOptions
  ): Promise<T>
  /** Detached call, e.g. `const { loadWithDelta } = IdMapIndex`. Resolves to an IdMapIndex. */
  static loadWithDelta(
    snapshotPath: string,
    deltaPath: string,
    options?: IdMapIndexCallOptions
  ): Promise<IdMapIndex>
  static async loadWithDelta(
    this: unknown,
    snapshotPath: string,
    deltaPath: string,
    options?: IdMapIndexCallOptions
  ): Promise<IdMapIndex> {
    requireNonEmptyPath(snapshotPath, 'IdMapIndex.loadWithDelta: snapshotPath')
    requireNonEmptyPath(deltaPath, 'IdMapIndex.loadWithDelta: deltaPath')
    const signal = readSignal('IdMapIndex.loadWithDelta', options)
    return IdMapIndex.startLoad(this, signal, (token) =>
      loadBinding().idx_load_with_delta_async(snapshotPath, deltaPath, token)
    )
  }

  /**
   * Load a TurboVec snapshot from the bytes `toBytes()` returns, or from the
   * contents of a TurboVec v8 snapshot file. Other snapshots, including v3,
   * are rejected. The bytes are copied when the call is made. Loads with
   * staged search off and 1 thread, as `load()` does. Resolves to a subclass
   * instance when called on a subclass, as `load()` does.
   */
  static fromBytes<T extends IdMapIndex>(
    this: IdMapIndexClass<T>,
    bytes: Uint8Array,
    options?: IdMapIndexCallOptions
  ): Promise<T>
  /** Detached call, e.g. `const { fromBytes } = IdMapIndex`. Resolves to an IdMapIndex. */
  static fromBytes(bytes: Uint8Array, options?: IdMapIndexCallOptions): Promise<IdMapIndex>
  static async fromBytes(
    this: unknown,
    bytes: Uint8Array,
    options?: IdMapIndexCallOptions
  ): Promise<IdMapIndex> {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('IdMapIndex.fromBytes: bytes must be a Uint8Array')
    }
    const signal = readSignal('IdMapIndex.fromBytes', options)
    return IdMapIndex.startLoad(this, signal, (token) =>
      loadBinding().idx_from_bytes_async(bytes, token)
    )
  }

  private static startLoad(
    ctor: unknown,
    signal: IdMapIndexAbortSignal | undefined,
    start: (token: Token) => Promise<NativeHandle>
  ) {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal))
    }
    const token = abortToken(signal)
    const loaded = startNow(() => start(token)).then((handle) =>
      IdMapIndex.fromHandle(ctor, handle)
    )
    return signal === undefined || token === undefined
      ? loaded
      : raceAbort(loaded, signal, token, disposeIndex)
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
    instance.readState()
    return instance
  }

  /**
   * Atomically add vectors with stable uint64 IDs. `vectors` is row-major and
   * must contain `ids.length * dim` finite components. TurboVec additionally
   * requires `abs(component) < 1e16`. UINT64_MAX is reserved.
   */
  async addWithIds(vectors: Float32Array, ids: BigUint64Array, options?: IdMapIndexCallOptions) {
    this.validateBatch('addWithIds', vectors, ids)
    const signal = readSignal('addWithIds', options)
    const borrow = waitsInQueue(this)
    const rows = snapshot(this, vectors)
    const keys = snapshot(this, ids)
    return enqueue(
      this,
      (token) =>
        this.mutate(() =>
          loadBinding().idx_add_async(ensureHandle(this), rows, keys, token, borrow)
        ),
      signal
    )
  }

  /**
   * Add vectors and append a durable v4 delta record. The index must first be
   * loaded from or successfully written to a snapshot, and then takes only
   * logged mutations. Delta logs are state-bound and support one evolving
   * writer; stale writers may catch up, and that catch-up remains applied
   * even if this add rejects. A complete record may also remain applied after
   * a durability error, leaving the index requiring a reload. Store delta
   * logs on a local filesystem with reliable cooperative locking. TurboVec
   * storage does not support logged mutations.
   */
  async addLogged(
    vectors: Float32Array,
    ids: BigUint64Array,
    deltaPath: string,
    options?: IdMapIndexCallOptions
  ) {
    this.validateBatch('addLogged', vectors, ids)
    requireNonEmptyPath(deltaPath, 'addLogged: deltaPath')
    const signal = readSignal('addLogged', options)
    const borrow = waitsInQueue(this)
    const rows = snapshot(this, vectors)
    const keys = snapshot(this, ids)
    return enqueue(
      this,
      (token) =>
        this.mutate(() =>
          loadBinding().idx_add_logged_async(
            ensureHandle(this),
            rows,
            keys,
            deltaPath,
            token,
            borrow
          )
        ),
      signal
    )
  }

  /**
   * Top-k similarity search over row-major queries. Results are sorted
   * by descending score, then ascending ID; TurboVec orders equal scores by
   * stored row, which removals and `buildIvf()` reshuffle. TurboVec rotates
   * queries without normalizing them and performs approximate rotated/quantized
   * dot-product scoring. TurboVec query components require
   * `abs(value) < 1e16`. Short rows use UINT64_MAX padding.
   */
  async search(queries: Float32Array, k: number, options?: IdMapIndexCallOptions) {
    this.validateSearch('search', queries, k)
    const signal = readSignal('search', options)
    const borrow = waitsInQueue(this)
    const input = snapshot(this, queries)
    return enqueue(
      this,
      (token) => loadBinding().idx_search_async(ensureHandle(this), input, k, token, borrow),
      signal
    )
  }

  /** Exact search restricted to the supplied external IDs. */
  async searchFiltered(
    queries: Float32Array,
    k: number,
    allowedIds: BigUint64Array,
    options?: IdMapIndexCallOptions
  ) {
    this.validateSearch('searchFiltered', queries, k)
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError('searchFiltered: allowedIds must be a BigUint64Array')
    }
    const signal = readSignal('searchFiltered', options)
    const borrow = waitsInQueue(this)
    const input = snapshot(this, queries)
    const allowed = snapshot(this, allowedIds)
    return enqueue(
      this,
      (token) =>
        loadBinding().idx_search_filtered_async(
          ensureHandle(this),
          input,
          k,
          allowed,
          token,
          borrow
        ),
      signal
    )
  }

  /**
   * Prepare an allowlist for repeated searches. Native mutation attempts and
   * `buildIvf()` invalidate all prepared filters created from this index. Call
   * `dispose()` when done to release native filter memory promptly; dropped
   * filters are reclaimed by GC. A filter that finishes after `signal` aborts
   * is disposed.
   */
  async prepareFilter(allowedIds: BigUint64Array, options?: IdMapIndexCallOptions) {
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError('prepareFilter: allowedIds must be a BigUint64Array')
    }
    const signal = readSignal('prepareFilter', options)
    const borrow = waitsInQueue(this)
    const allowed = snapshot(this, allowedIds)
    return enqueue(
      this,
      async (token) => {
        const filterHandle = await loadBinding().idx_filter_create_async(
          ensureHandle(this),
          allowed,
          token,
          borrow
        )
        // dispose() ran while the filter was being built. Free the filter now,
        // while the index is still alive: fabric requires the index to outlive
        // its filters, and the index is freed once this operation settles.
        if (this[HANDLE] === null) {
          loadBinding().idx_filter_dispose(filterHandle)
          throw new Error('IdMapIndex has been disposed')
        }
        return this.registerFilter(filterHandle)
      },
      signal,
      (filter) => filter.dispose().catch(swallow)
    )
  }

  /**
   * Build deterministic in-memory IVF-flat search state. Mutations invalidate
   * it, and snapshots do not persist it. Disposes every prepared filter, as a
   * mutation does: on TurboVec storage the build regroups the rows by IVF list.
   * A build that has started runs to the end even when `signal` aborts.
   */
  async buildIvf(nLists: number, nIter = 0, options?: IdMapIndexCallOptions) {
    if (!isPositiveInt32(nLists)) {
      throw new TypeError('buildIvf: nLists must be a positive int32')
    }
    if (!isNonNegativeInt32(nIter)) {
      throw new TypeError('buildIvf: nIter must be a non-negative int32')
    }
    const signal = readSignal('buildIvf', options)
    return enqueue(
      this,
      async (token) => {
        try {
          await loadBinding().idx_build_ivf_async(ensureHandle(this), nLists, nIter, token)
        } finally {
          // At this call's turn, once the native build is done: fabric refuses
          // TurboVec filters prepared before the build.
          this.disposeFilters(true)
        }
      },
      signal
    )
  }

  /**
   * Search the IVF-flat candidate lists. `buildIvf()` must have run after the
   * latest mutation or load. Higher `nProbe` generally improves recall.
   */
  async searchIvf(
    queries: Float32Array,
    k: number,
    nProbe: number,
    options?: IdMapIndexCallOptions
  ) {
    this.validateSearch('searchIvf', queries, k)
    if (!isPositiveInt32(nProbe)) {
      throw new TypeError('searchIvf: nProbe must be a positive int32')
    }
    const signal = readSignal('searchIvf', options)
    const borrow = waitsInQueue(this)
    const input = snapshot(this, queries)
    return enqueue(
      this,
      (token) =>
        loadBinding().idx_search_ivf_async(ensureHandle(this), input, k, nProbe, token, borrow),
      signal
    )
  }

  /** Remove an ID, resolving to false when it is not present. */
  async remove(id: bigint, options?: IdMapIndexCallOptions) {
    this.validateId('remove', id)
    const signal = readSignal('remove', options)
    return enqueue(
      this,
      async (token) => {
        const removed = await loadBinding().idx_remove_async(ensureHandle(this), id, token)
        if (removed) {
          this.afterMutation()
        }
        return removed
      },
      signal
    )
  }

  /**
   * Remove an ID and append a durable v4 delta record. Resolves to false when
   * the ID is absent. Stale-writer catch-up may still mutate the index when
   * this resolves to false or rejects, and a complete record may remain
   * applied after a durability error. The same binding and reload rules as
   * `addLogged()` apply.
   */
  async removeLogged(id: bigint, deltaPath: string, options?: IdMapIndexCallOptions) {
    this.validateId('removeLogged', id)
    requireNonEmptyPath(deltaPath, 'removeLogged: deltaPath')
    const signal = readSignal('removeLogged', options)
    return enqueue(
      this,
      (token) =>
        this.mutate(() =>
          loadBinding().idx_remove_logged_async(ensureHandle(this), id, deltaPath, token)
        ),
      signal
    )
  }

  /** Physically reclaim tombstoned slots. Rejected on delta-bound indexes. */
  async compact(options?: IdMapIndexCallOptions) {
    const signal = readSignal('compact', options)
    return enqueue(
      this,
      (token) => this.mutate(() => loadBinding().idx_compact_async(ensureHandle(this), token)),
      signal
    )
  }

  /** Resolve to whether the index contains an external ID. */
  async contains(id: bigint, options?: IdMapIndexCallOptions) {
    this.validateId('contains', id)
    const signal = readSignal('contains', options)
    // A hash lookup: run on the JS thread at this call's turn in the queue,
    // when no worker holds the index.
    return enqueue(this, () => loadBinding().idx_contains(ensureHandle(this), id), signal)
  }

  /** Best-effort warmup of TurboVec rotation and codebook state. */
  async prepare(options?: IdMapIndexCallOptions) {
    const signal = readSignal('prepare', options)
    return enqueue(
      this,
      (token) => loadBinding().idx_prepare_async(ensureHandle(this), token),
      signal
    )
  }

  /**
   * Persist a checksummed v2 snapshot for f32/q4/q8, or a v8 snapshot for
   * TurboVec (v3 for an index loaded from a v3 snapshot). Delta-bound indexes
   * must use `compactDelta()`. A NotDurable error means replacement succeeded
   * but parent-directory durability was not confirmed. See
   * {@link IdMapIndexWriteOptions} for `durability`.
   */
  async write(path: string, options?: IdMapIndexWriteOptions) {
    requireNonEmptyPath(path, 'write: path')
    const signal = readSignal('write', options)
    const fast = readWriteFast(options)
    return enqueue(
      this,
      (token) => loadBinding().idx_write_async(ensureHandle(this), path, fast, token),
      signal
    )
  }

  /**
   * Save a TurboVec index to `path`, writing only what changed since its last
   * sync there. The first sync to a path, and the first after a calibration
   * or `buildIvf()`, writes the whole file. Each sync is durable, and a crash
   * at any point leaves the previous sync loadable. An index loaded from a
   * synced file keeps syncing to it incrementally. One index may sync to a
   * path at a time: when another writer has changed the file, this rejects
   * with `IOError` and the file must be loaded again to continue. Rejects
   * with `InvalidArgument` for non-TurboVec storage and for an index loaded
   * from a v3 snapshot.
   */
  async sync(path: string, options?: IdMapIndexCallOptions) {
    requireNonEmptyPath(path, 'sync: path')
    const signal = readSignal('sync', options)
    return enqueue(
      this,
      (token) => loadBinding().idx_sync_async(ensureHandle(this), path, token),
      signal
    )
  }

  /**
   * The bytes `write()` would put in a TurboVec snapshot file, for storing
   * an index somewhere other than a file. Load them with
   * `IdMapIndex.fromBytes()`. Rejects with `InvalidArgument` for non-TurboVec
   * storage and for an index loaded from a v3 snapshot.
   */
  async toBytes(options?: IdMapIndexCallOptions): Promise<Uint8Array> {
    const signal = readSignal('toBytes', options)
    return enqueue(
      this,
      (token) => loadBinding().idx_to_bytes_async(ensureHandle(this), token),
      signal
    )
  }

  /**
   * All live IDs. The order is stable until the index changes, and on
   * TurboVec storage until `buildIvf()`.
   */
  async ids(options?: IdMapIndexCallOptions): Promise<BigUint64Array> {
    const signal = readSignal('ids', options)
    return enqueue(
      this,
      (token) => loadBinding().idx_ids_async(ensureHandle(this), token),
      signal
    )
  }

  /**
   * Set how many threads the calls queued after this one may use, from 1
   * (the default) to 256, the addon's worker thread included. Searches,
   * adds and TurboVec calibration split their work across them; results do
   * not depend on the count. The extra threads come from one pool shared by
   * every index in the process. Not saved in snapshots: a loaded index
   * starts at 1.
   */
  async setThreads(threads: number, options?: IdMapIndexCallOptions) {
    requireThreads(threads, 'setThreads: threads')
    const signal = readSignal('setThreads', options)
    // Only stores the count, so it runs on the JS thread at this call's turn.
    return enqueue(
      this,
      () => {
        const handle = ensureHandle(this)
        const native = loadBinding()
        native.idx_set_threads(handle, threads)
        this[THREADS] = native.idx_threads(handle)
      },
      signal
    )
  }

  /**
   * Write a fresh snapshot and reset its matching v4 delta log. A
   * PartialCompact error means replacement occurred but durability or log
   * reset could not be confirmed. TurboVec storage does not support delta
   * compaction and is rejected with `InvalidArgument`.
   */
  async compactDelta(snapshotPath: string, deltaPath: string, options?: IdMapIndexCallOptions) {
    requireNonEmptyPath(snapshotPath, 'compactDelta: snapshotPath')
    requireNonEmptyPath(deltaPath, 'compactDelta: deltaPath')
    const signal = readSignal('compactDelta', options)
    return enqueue(
      this,
      (token) =>
        this.mutate(() =>
          loadBinding().idx_compact_delta_async(ensureHandle(this), snapshotPath, deltaPath, token)
        ),
      signal
    )
  }

  /**
   * Turn TurboVec staged search on or off for the searches queued after this
   * call. On, a search of 32,768 or more vectors scans a compressed form
   * first and scores only a shortlist: several times faster per query, but
   * it can miss some of the best matches, especially at small k. It applies
   * only at a dimension divisible by 32, on hosts that support it, and never
   * to an index loaded from a v3 snapshot or to `turbovec-q3` storage;
   * elsewhere the setting is kept but every search scans in full. Rejects
   * for non-TurboVec storage. Not saved in snapshots.
   */
  async setStagedSearch(enabled: boolean, options?: IdMapIndexCallOptions) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('setStagedSearch: enabled must be a boolean')
    }
    const signal = readSignal('setStagedSearch', options)
    return enqueue(
      this,
      async (token) => {
        await loadBinding().idx_set_staged_async(ensureHandle(this), enabled, token)
        this[STAGED] = enabled
      },
      signal
    )
  }

  /** Number of live entries after the last call that finished. */
  get length() {
    ensureHandle(this)
    return this[LENGTH]
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

  /** Storage mode; unlike `bitWidth`, tells TurboVec q4 from generic q4. */
  get storage() {
    ensureHandle(this)
    return this[STORAGE]
  }

  /** Threads the index's calls may use, as of the last `setThreads()` that finished. */
  get threads() {
    ensureHandle(this)
    return this[THREADS]
  }

  /**
   * Whether this is a TurboVec index loaded from a v3 snapshot of an earlier
   * release. It keeps that encoding and writes v3, and supports neither
   * `sync()` nor `toBytes()`.
   */
  get legacy() {
    ensureHandle(this)
    return this[LEGACY]
  }

  /**
   * Byte length of the snapshot `toBytes()` would return, as of the last call
   * that finished, computed without serializing. 0 for indexes `toBytes()`
   * rejects: non-TurboVec storages and legacy TurboVec indexes.
   */
  get serializedSize() {
    ensureHandle(this)
    return this[SERIALIZED_SIZE]
  }

  /**
   * Whether a TurboVec index holds a TQ+ calibration, as of the last call
   * that finished. A fresh TurboVec index calibrates from its first
   * `addWithIds()` batch when that batch has at least 1,000 rows; other
   * storages are never calibrated.
   */
  get calibrated() {
    ensureHandle(this)
    return this[CALIBRATED]
  }

  /**
   * Whether staged search is turned on, as of the last `setStagedSearch()`
   * that finished. Off for every new or loaded index. Reports the setting,
   * not whether a search runs in stages: see `setStagedSearch()`.
   */
  get stagedSearch() {
    ensureHandle(this)
    return this[STAGED]
  }

  /**
   * Release filters and native index resources. The index cannot be used
   * after this call, and calls that have not started reject. A call that is
   * running finishes first; the native index is freed after it. Resolves
   * once the native index has been freed, and rejects if freeing it fails.
   * This operation is idempotent.
   */
  dispose(): Promise<void> {
    const handle = this[HANDLE]
    if (handle === null) {
      return this[QUEUE].then(swallow)
    }
    this.disposeFilters(false)
    this[HANDLE] = null
    return releaseAfterQueue(this, () => loadBinding().idx_dispose(handle))
  }

  // Frees every prepared filter. `now` is for a call's own turn in the queue,
  // when no worker holds the index; otherwise each free waits its turn.
  private disposeFilters(now: boolean) {
    for (const ref of this[FILTERS]) {
      const filter = ref.deref()
      if (filter === undefined) {
        continue
      }
      if (!now) {
        // The caller learns of a failed free from the filter's own dispose().
        filter.dispose().catch(swallow)
        continue
      }
      const detached = detachFilter(filter)
      if (detached !== null) {
        loadBinding().idx_filter_dispose(detached.filterHandle)
      }
    }
    this[FILTERS].clear()
  }

  // Reads the cached state back from the native index. Called at a turn in
  // the queue, or before the index is shared, when no worker holds it.
  private readState() {
    const handle = this[HANDLE]
    if (handle === null) {
      return
    }
    const native = loadBinding()
    this[DIM] = native.idx_dim(handle)
    this[BIT_WIDTH] = native.idx_bit_width(handle)
    this[LENGTH] = native.idx_len(handle)
    this[CALIBRATED] = native.idx_calibrated(handle)
    this[STAGED] = native.idx_staged(handle)
    this[THREADS] = native.idx_threads(handle)
    this[STORAGE] = native.idx_storage(handle)
    this[LEGACY] = native.idx_legacy(handle)
    this[SERIALIZED_SIZE] = native.idx_serialized_size(handle)
  }

  // After a mutation: prepared filters no longer match the index, and the
  // cached state may have changed.
  private afterMutation() {
    this.disposeFilters(true)
    this.readState()
  }

  // Runs a native mutation, then invalidates prepared filters whether or not
  // it succeeded: a failed mutation may still have changed the index.
  private async mutate<T>(start: () => Promise<T>) {
    try {
      return await start()
    } finally {
      this.afterMutation()
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
