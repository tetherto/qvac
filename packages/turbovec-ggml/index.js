"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdMapIndex = exports.IdMapIndexFilter = void 0;
const HANDLE = Symbol('IdMapIndex.handle');
const FILTER_HANDLE = Symbol('IdMapIndexFilter.handle');
const FILTER_OWNER = Symbol('IdMapIndexFilter.owner');
const FILTER_REF = Symbol('IdMapIndexFilter.ref');
const FILTER_RELEASED = Symbol('IdMapIndexFilter.released');
const FILTERS = Symbol('IdMapIndex.filters');
const FILTERS_PRUNE_AT = Symbol('IdMapIndex.filtersPruneAt');
const QUEUE = Symbol('IdMapIndex.queue');
const PENDING = Symbol('IdMapIndex.pending');
const DIM = Symbol('IdMapIndex.dim');
const BIT_WIDTH = Symbol('IdMapIndex.bitWidth');
const LENGTH = Symbol('IdMapIndex.length');
const CALIBRATED = Symbol('IdMapIndex.calibrated');
const STAGED = Symbol('IdMapIndex.staged');
const THREADS = Symbol('IdMapIndex.threads');
const STORAGE = Symbol('IdMapIndex.storage');
const LEGACY = Symbol('IdMapIndex.legacy');
const SERIALIZED_SIZE = Symbol('IdMapIndex.serializedSize');
const INT32_MAX = 0x7fffffff;
// Fabric's limit for ggml_vec_index_set_threads.
const MAX_THREADS = 256;
// Dropped filters leave dead WeakRefs behind. Pruning once the set doubles
// keeps prepareFilter amortized O(1) instead of rescanning on every call.
const MIN_FILTERS_PRUNE_AT = 64;
const BIT_WIDTH_BY_STORAGE = {
    f32: 32,
    q8: 8,
    q4: 4,
    'turbovec-q4': 4,
    'turbovec-q3': 3,
    'turbovec-q2': 2
};
const STORAGE_BY_BIT_WIDTH = {
    2: 'turbovec-q2',
    3: 'turbovec-q3',
    4: 'q4',
    8: 'q8',
    32: 'f32'
};
let binding;
function loadBinding() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- The native Bare binding is resolved lazily through CommonJS.
    binding ??= require('./binding');
    return binding;
}
function isPositiveInt32(value) {
    return Number.isInteger(value) && value > 0 && value <= INT32_MAX;
}
function isNonNegativeInt32(value) {
    return Number.isInteger(value) && value >= 0 && value <= INT32_MAX;
}
function requireThreads(value, name) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_THREADS) {
        throw new TypeError(`${name} must be an integer from 1 to ${MAX_THREADS}`);
    }
}
function readWriteFast(options) {
    const durability = options?.durability;
    if (durability === undefined || durability === 'durable') {
        return false;
    }
    if (durability === 'fast') {
        return true;
    }
    throw new TypeError("write: options.durability must be 'durable' or 'fast'");
}
function requireNonEmptyPath(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}
function readSignal(name, options) {
    if (options === undefined) {
        return undefined;
    }
    if (options === null || typeof options !== 'object') {
        throw new TypeError(`${name}: options must be an object`);
    }
    const { signal } = options;
    if (signal === undefined) {
        return undefined;
    }
    if (signal === null ||
        typeof signal !== 'object' ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function') {
        throw new TypeError(`${name}: options.signal must be an AbortSignal`);
    }
    return signal;
}
// The caller's own reason, passed through as fetch() does: an AbortError or
// TimeoutError unless they aborted with something else. Typed as Error for
// the code that throws it.
function abortReason(signal) {
    if (signal.reason !== undefined) {
        return signal.reason;
    }
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}
function ensureHandle(index) {
    const handle = index[HANDLE];
    if (handle === null) {
        throw new Error('IdMapIndex has been disposed');
    }
    return handle;
}
function swallow() { }
// Calls `run` now; a synchronous throw becomes a rejection.
function startNow(run) {
    return new Promise((resolve) => {
        resolve(run());
    });
}
// The abort token for a call with `signal`, or undefined without one.
function abortToken(signal) {
    return signal === undefined ? undefined : loadBinding().idx_abort_token_create();
}
// Rejects with the signal's reason once it aborts, without waiting for
// `result`, and sets `token`, so a native job that has not started yet is
// skipped. A value `result` still produces after that is passed to
// `discard`, so resources such as a loaded index or a prepared filter are
// freed.
function raceAbort(result, signal, token, discard) {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            loadBinding().idx_abort_token_abort(token);
            reject(abortReason(signal));
            result.then(discard ?? swallow, swallow);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        result.finally(() => signal.removeEventListener('abort', onAbort)).then(resolve, reject);
    });
}
// Runs operations on one index one at a time, in call order. Each runs once
// every earlier operation, and every native free queued before it, has
// settled, so `run` always finds no worker holding the index. On an idle
// index `run` starts now, so the native job holds the index before the
// caller's next statement (a `dispose()` right after lets it finish). An
// operation whose signal aborts while it waits, here or on a worker thread,
// is skipped. `run` gets the call's abort token to pass to the native call.
function enqueue(index, run, signal, discard) {
    ensureHandle(index);
    if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
    }
    const token = abortToken(signal);
    const guarded = () => {
        if (signal?.aborted) {
            throw abortReason(signal);
        }
        return run(token);
    };
    const result = index[PENDING] === 0 ? startNow(guarded) : index[QUEUE].then(guarded);
    index[PENDING] += 1;
    const settled = () => {
        index[PENDING] -= 1;
    };
    index[QUEUE] = result.then(settled, settled);
    return signal === undefined || token === undefined
        ? result
        : raceAbort(result, signal, token, discard);
}
// Whether a call made now waits behind earlier ones. The native call takes
// its array inputs when it starts; a call that waits starts later, so its
// inputs are copied here, at call time, by snapshot(): the caller may change
// or transfer them once the call returns. The native call then keeps those
// private copies instead of copying them again (the binding's `borrow`).
// Must be read in the same synchronous step as the `enqueue()` it feeds.
function waitsInQueue(index) {
    return index[PENDING] !== 0;
}
function snapshot(index, array) {
    return waitsInQueue(index) ? array.slice() : array;
}
// Frees a native handle once everything queued on `owner` has settled, or
// now when nothing is. A queued free counts as pending work until it has
// run, so a later free, such as the index's own, always runs after it. The
// returned promise rejects when the free throws.
function releaseAfterQueue(owner, release) {
    if (owner[PENDING] === 0) {
        return startNow(release);
    }
    owner[PENDING] += 1;
    const done = () => {
        owner[PENDING] -= 1;
    };
    const released = owner[QUEUE].then(release);
    owner[QUEUE] = released.then(done, done);
    return released;
}
function normalizeStorageOptions(options) {
    const { bitWidth, storage } = options;
    if (storage !== undefined) {
        if (typeof storage !== 'string' ||
            !Object.prototype.hasOwnProperty.call(BIT_WIDTH_BY_STORAGE, storage)) {
            throw new TypeError("IdMapIndex: storage must be 'f32', 'q8', 'q4', 'turbovec-q4', 'turbovec-q3', or 'turbovec-q2'");
        }
        // A null bitWidth counts as the default 8, as it did in embed-llamacpp.
        if (bitWidth !== undefined && (bitWidth ?? 8) !== BIT_WIDTH_BY_STORAGE[storage]) {
            throw new TypeError('IdMapIndex: bitWidth does not match storage');
        }
        return storage;
    }
    const width = bitWidth ?? 8;
    if (typeof width !== 'number' ||
        !Object.prototype.hasOwnProperty.call(STORAGE_BY_BIT_WIDTH, width)) {
        throw new TypeError('IdMapIndex: bitWidth must be 2, 3, 4, 8, or 32');
    }
    return STORAGE_BY_BIT_WIDTH[width];
}
// Unlinks a filter from its owner and returns its native handle, or null
// when it was already disposed.
function detachFilter(filter) {
    const filterHandle = filter[FILTER_HANDLE];
    if (filterHandle === null) {
        return null;
    }
    const owner = filter[FILTER_OWNER];
    const ref = filter[FILTER_REF];
    if (owner !== null && ref !== null) {
        owner[FILTERS].delete(ref);
    }
    filter[FILTER_HANDLE] = null;
    filter[FILTER_OWNER] = null;
    filter[FILTER_REF] = null;
    return { filterHandle, owner };
}
class IdMapIndexFilter {
    [FILTER_HANDLE] = null;
    [FILTER_OWNER] = null;
    [FILTER_REF] = null;
    // Settles once the native filter has been freed. Already resolved when the
    // owner freed it at a turn in its queue, which happens as it is detached.
    [FILTER_RELEASED] = Promise.resolve();
    constructor() {
        throw new TypeError('IdMapIndexFilter instances must be created by IdMapIndex.prepareFilter()');
    }
    /**
     * Search with this prepared allowlist, queued behind the owner's other
     * operations. Rejects when an earlier mutation of the owner disposed the
     * filter: every mutation invalidates the owner's filters.
     */
    async search(queries, k, options) {
        validateFilterSearch('IdMapIndexFilter.search', queries, k);
        const signal = readSignal('IdMapIndexFilter.search', options);
        const owner = this[FILTER_OWNER];
        if (owner === null || this[FILTER_HANDLE] === null) {
            throw new Error('IdMapIndexFilter has been disposed');
        }
        const borrow = waitsInQueue(owner);
        const input = snapshot(owner, queries);
        return enqueue(owner, (token) => {
            const filterHandle = this[FILTER_HANDLE];
            if (this[FILTER_OWNER] === null || filterHandle === null) {
                throw new Error('IdMapIndexFilter has been disposed');
            }
            return loadBinding().idx_search_prepared_filtered_async(ensureHandle(owner), filterHandle, input, k, token, borrow);
        }, signal);
    }
    /**
     * Release the prepared native filter. The filter cannot be used after this
     * call. While the owner has operations queued, the native filter is freed
     * after they settle. Resolves once the native filter has been freed, and
     * rejects if freeing it fails. This operation is idempotent: a later call
     * returns the same promise.
     */
    dispose() {
        const detached = detachFilter(this);
        if (detached === null) {
            return this[FILTER_RELEASED];
        }
        const { filterHandle, owner } = detached;
        const release = () => loadBinding().idx_filter_dispose(filterHandle);
        this[FILTER_RELEASED] = owner === null ? startNow(release) : releaseAfterQueue(owner, release);
        return this[FILTER_RELEASED];
    }
}
exports.IdMapIndexFilter = IdMapIndexFilter;
function validateFilterSearch(name, queries, k) {
    if (!(queries instanceof Float32Array)) {
        throw new TypeError(`${name}: queries must be a Float32Array`);
    }
    if (!isPositiveInt32(k)) {
        throw new TypeError(`${name}: k must be a positive int32`);
    }
}
// A dropped filter needs no JS finalizer: its handle is a native external
// whose own finalizer frees the native filter once the handle is collected.
function createFilter(owner, handle) {
    const filter = Object.create(IdMapIndexFilter.prototype);
    filter[FILTER_OWNER] = owner;
    filter[FILTER_HANDLE] = handle;
    filter[FILTER_REF] = new WeakRef(filter);
    // Object.create() skips the class's field initializers.
    filter[FILTER_RELEASED] = Promise.resolve();
    return filter;
}
function disposeIndex(index) {
    return index.dispose();
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
class IdMapIndex {
    static Filter = IdMapIndexFilter;
    static IdMapIndex = IdMapIndex;
    static IdMapIndexFilter = IdMapIndexFilter;
    [HANDLE] = null;
    [FILTERS] = new Set();
    [FILTERS_PRUNE_AT] = MIN_FILTERS_PRUNE_AT;
    [QUEUE] = Promise.resolve();
    [PENDING] = 0;
    // Kept in JS so the getters never reach the native index while a worker
    // holds it. `dim` and `bitWidth` are fixed; the rest are read again after
    // each call that can change them.
    [DIM] = 0;
    [BIT_WIDTH] = 8;
    [LENGTH] = 0;
    [CALIBRATED] = false;
    [STAGED] = false;
    [THREADS] = 1;
    [STORAGE] = 'q8';
    [LEGACY] = false;
    [SERIALIZED_SIZE] = 0;
    constructor(options) {
        const { dim, threads } = options ?? {};
        if (!isPositiveInt32(dim)) {
            throw new TypeError('IdMapIndex: dim must be a positive int32');
        }
        const storage = normalizeStorageOptions(options);
        if (storage.startsWith('turbovec-') && (dim > 16_384 || dim % 8 !== 0)) {
            throw new RangeError('IdMapIndex: TurboVec dim must be divisible by 8 and no greater than 16384');
        }
        if (threads !== undefined) {
            requireThreads(threads, 'IdMapIndex: threads');
        }
        const native = loadBinding();
        const handle = native.idx_create({ dim, storage });
        this[HANDLE] = handle;
        if (threads !== undefined) {
            native.idx_set_threads(handle, threads);
        }
        this.readState();
    }
    static async load(path, options) {
        requireNonEmptyPath(path, 'IdMapIndex.load: path');
        const signal = readSignal('IdMapIndex.load', options);
        return IdMapIndex.startLoad(this, signal, (token) => loadBinding().idx_load_async(path, token));
    }
    static async loadMmap(path, options) {
        requireNonEmptyPath(path, 'IdMapIndex.loadMmap: path');
        const signal = readSignal('IdMapIndex.loadMmap', options);
        return IdMapIndex.startLoad(this, signal, (token) => loadBinding().idx_load_mmap_async(path, token));
    }
    static async loadWithDelta(snapshotPath, deltaPath, options) {
        requireNonEmptyPath(snapshotPath, 'IdMapIndex.loadWithDelta: snapshotPath');
        requireNonEmptyPath(deltaPath, 'IdMapIndex.loadWithDelta: deltaPath');
        const signal = readSignal('IdMapIndex.loadWithDelta', options);
        return IdMapIndex.startLoad(this, signal, (token) => loadBinding().idx_load_with_delta_async(snapshotPath, deltaPath, token));
    }
    static async fromBytes(bytes, options) {
        if (!(bytes instanceof Uint8Array)) {
            throw new TypeError('IdMapIndex.fromBytes: bytes must be a Uint8Array');
        }
        const signal = readSignal('IdMapIndex.fromBytes', options);
        return IdMapIndex.startLoad(this, signal, (token) => loadBinding().idx_from_bytes_async(bytes, token));
    }
    static startLoad(ctor, signal, start) {
        if (signal?.aborted) {
            return Promise.reject(abortReason(signal));
        }
        const token = abortToken(signal);
        const loaded = startNow(() => start(token)).then((handle) => IdMapIndex.fromHandle(ctor, handle));
        return signal === undefined || token === undefined
            ? loaded
            : raceAbort(loaded, signal, token, disposeIndex);
    }
    // `ctor` is the class a loader was called on. A detached call such as
    // `const { load } = IdMapIndex` has no class, so it falls back to IdMapIndex.
    static fromHandle(ctor, handle) {
        const candidate = typeof ctor === 'function' ? ctor.prototype : undefined;
        const isIndexPrototype = candidate === IdMapIndex.prototype || candidate instanceof IdMapIndex;
        const prototype = isIndexPrototype ? candidate : IdMapIndex.prototype;
        const instance = Object.create(prototype);
        instance[HANDLE] = handle;
        instance[FILTERS] = new Set();
        instance[FILTERS_PRUNE_AT] = MIN_FILTERS_PRUNE_AT;
        instance[QUEUE] = Promise.resolve();
        instance[PENDING] = 0;
        instance.readState();
        return instance;
    }
    /**
     * Atomically add vectors with stable uint64 IDs. `vectors` is row-major and
     * must contain `ids.length * dim` finite components. TurboVec additionally
     * requires `abs(component) < 1e16`. UINT64_MAX is reserved.
     */
    async addWithIds(vectors, ids, options) {
        this.validateBatch('addWithIds', vectors, ids);
        const signal = readSignal('addWithIds', options);
        const borrow = waitsInQueue(this);
        const rows = snapshot(this, vectors);
        const keys = snapshot(this, ids);
        return enqueue(this, (token) => this.mutate(() => loadBinding().idx_add_async(ensureHandle(this), rows, keys, token, borrow)), signal);
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
    async addLogged(vectors, ids, deltaPath, options) {
        this.validateBatch('addLogged', vectors, ids);
        requireNonEmptyPath(deltaPath, 'addLogged: deltaPath');
        const signal = readSignal('addLogged', options);
        const borrow = waitsInQueue(this);
        const rows = snapshot(this, vectors);
        const keys = snapshot(this, ids);
        return enqueue(this, (token) => this.mutate(() => loadBinding().idx_add_logged_async(ensureHandle(this), rows, keys, deltaPath, token, borrow)), signal);
    }
    /**
     * Top-k similarity search over row-major queries. Results are sorted
     * by descending score, then ascending ID; TurboVec orders equal scores by
     * stored row, which removals and `buildIvf()` reshuffle. TurboVec rotates
     * queries without normalizing them and performs approximate rotated/quantized
     * dot-product scoring. TurboVec query components require
     * `abs(value) < 1e16`. Short rows use UINT64_MAX padding.
     */
    async search(queries, k, options) {
        this.validateSearch('search', queries, k);
        const signal = readSignal('search', options);
        const borrow = waitsInQueue(this);
        const input = snapshot(this, queries);
        return enqueue(this, (token) => loadBinding().idx_search_async(ensureHandle(this), input, k, token, borrow), signal);
    }
    /** Exact search restricted to the supplied external IDs. */
    async searchFiltered(queries, k, allowedIds, options) {
        this.validateSearch('searchFiltered', queries, k);
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError('searchFiltered: allowedIds must be a BigUint64Array');
        }
        const signal = readSignal('searchFiltered', options);
        const borrow = waitsInQueue(this);
        const input = snapshot(this, queries);
        const allowed = snapshot(this, allowedIds);
        return enqueue(this, (token) => loadBinding().idx_search_filtered_async(ensureHandle(this), input, k, allowed, token, borrow), signal);
    }
    /**
     * Prepare an allowlist for repeated searches. Native mutation attempts and
     * `buildIvf()` invalidate all prepared filters created from this index. Call
     * `dispose()` when done to release native filter memory promptly; dropped
     * filters are reclaimed by GC. A filter that finishes after `signal` aborts
     * is disposed.
     */
    async prepareFilter(allowedIds, options) {
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError('prepareFilter: allowedIds must be a BigUint64Array');
        }
        const signal = readSignal('prepareFilter', options);
        const borrow = waitsInQueue(this);
        const allowed = snapshot(this, allowedIds);
        return enqueue(this, async (token) => {
            const filterHandle = await loadBinding().idx_filter_create_async(ensureHandle(this), allowed, token, borrow);
            // dispose() ran while the filter was being built. Free the filter now,
            // while the index is still alive: fabric requires the index to outlive
            // its filters, and the index is freed once this operation settles.
            if (this[HANDLE] === null) {
                loadBinding().idx_filter_dispose(filterHandle);
                throw new Error('IdMapIndex has been disposed');
            }
            return this.registerFilter(filterHandle);
        }, signal, (filter) => filter.dispose().catch(swallow));
    }
    /**
     * Build deterministic in-memory IVF-flat search state. Mutations invalidate
     * it, and snapshots do not persist it. Disposes every prepared filter, as a
     * mutation does: on TurboVec storage the build regroups the rows by IVF list.
     * A build that has started runs to the end even when `signal` aborts.
     */
    async buildIvf(nLists, nIter = 0, options) {
        if (!isPositiveInt32(nLists)) {
            throw new TypeError('buildIvf: nLists must be a positive int32');
        }
        if (!isNonNegativeInt32(nIter)) {
            throw new TypeError('buildIvf: nIter must be a non-negative int32');
        }
        const signal = readSignal('buildIvf', options);
        return enqueue(this, async (token) => {
            try {
                await loadBinding().idx_build_ivf_async(ensureHandle(this), nLists, nIter, token);
            }
            finally {
                // At this call's turn, once the native build is done: fabric refuses
                // TurboVec filters prepared before the build.
                this.disposeFilters(true);
            }
        }, signal);
    }
    /**
     * Search the IVF-flat candidate lists. `buildIvf()` must have run after the
     * latest mutation or load. Higher `nProbe` generally improves recall.
     */
    async searchIvf(queries, k, nProbe, options) {
        this.validateSearch('searchIvf', queries, k);
        if (!isPositiveInt32(nProbe)) {
            throw new TypeError('searchIvf: nProbe must be a positive int32');
        }
        const signal = readSignal('searchIvf', options);
        const borrow = waitsInQueue(this);
        const input = snapshot(this, queries);
        return enqueue(this, (token) => loadBinding().idx_search_ivf_async(ensureHandle(this), input, k, nProbe, token, borrow), signal);
    }
    /** Remove an ID, resolving to false when it is not present. */
    async remove(id, options) {
        this.validateId('remove', id);
        const signal = readSignal('remove', options);
        return enqueue(this, async (token) => {
            const removed = await loadBinding().idx_remove_async(ensureHandle(this), id, token);
            if (removed) {
                this.afterMutation();
            }
            return removed;
        }, signal);
    }
    /**
     * Remove an ID and append a durable v4 delta record. Resolves to false when
     * the ID is absent. Stale-writer catch-up may still mutate the index when
     * this resolves to false or rejects, and a complete record may remain
     * applied after a durability error. The same binding and reload rules as
     * `addLogged()` apply.
     */
    async removeLogged(id, deltaPath, options) {
        this.validateId('removeLogged', id);
        requireNonEmptyPath(deltaPath, 'removeLogged: deltaPath');
        const signal = readSignal('removeLogged', options);
        return enqueue(this, (token) => this.mutate(() => loadBinding().idx_remove_logged_async(ensureHandle(this), id, deltaPath, token)), signal);
    }
    /** Physically reclaim tombstoned slots. Rejected on delta-bound indexes. */
    async compact(options) {
        const signal = readSignal('compact', options);
        return enqueue(this, (token) => this.mutate(() => loadBinding().idx_compact_async(ensureHandle(this), token)), signal);
    }
    /** Resolve to whether the index contains an external ID. */
    async contains(id, options) {
        this.validateId('contains', id);
        const signal = readSignal('contains', options);
        // A hash lookup: run on the JS thread at this call's turn in the queue,
        // when no worker holds the index.
        return enqueue(this, () => loadBinding().idx_contains(ensureHandle(this), id), signal);
    }
    /** Best-effort warmup of TurboVec rotation and codebook state. */
    async prepare(options) {
        const signal = readSignal('prepare', options);
        return enqueue(this, (token) => loadBinding().idx_prepare_async(ensureHandle(this), token), signal);
    }
    /**
     * Persist a checksummed v2 snapshot for f32/q4/q8, or a v8 snapshot for
     * TurboVec (v3 for an index loaded from a v3 snapshot). Delta-bound indexes
     * must use `compactDelta()`. A NotDurable error means replacement succeeded
     * but parent-directory durability was not confirmed. See
     * {@link IdMapIndexWriteOptions} for `durability`.
     */
    async write(path, options) {
        requireNonEmptyPath(path, 'write: path');
        const signal = readSignal('write', options);
        const fast = readWriteFast(options);
        return enqueue(this, (token) => loadBinding().idx_write_async(ensureHandle(this), path, fast, token), signal);
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
    async sync(path, options) {
        requireNonEmptyPath(path, 'sync: path');
        const signal = readSignal('sync', options);
        return enqueue(this, (token) => loadBinding().idx_sync_async(ensureHandle(this), path, token), signal);
    }
    /**
     * The bytes `write()` would put in a TurboVec snapshot file, for storing
     * an index somewhere other than a file. Load them with
     * `IdMapIndex.fromBytes()`. Rejects with `InvalidArgument` for non-TurboVec
     * storage and for an index loaded from a v3 snapshot.
     */
    async toBytes(options) {
        const signal = readSignal('toBytes', options);
        return enqueue(this, (token) => loadBinding().idx_to_bytes_async(ensureHandle(this), token), signal);
    }
    /**
     * All live IDs. The order is stable until the index changes, and on
     * TurboVec storage until `buildIvf()`.
     */
    async ids(options) {
        const signal = readSignal('ids', options);
        return enqueue(this, (token) => loadBinding().idx_ids_async(ensureHandle(this), token), signal);
    }
    /**
     * Set how many threads the calls queued after this one may use, from 1
     * (the default) to 256, the addon's worker thread included. Searches,
     * adds and TurboVec calibration split their work across them; results do
     * not depend on the count. The extra threads come from one pool shared by
     * every index in the process. Not saved in snapshots: a loaded index
     * starts at 1.
     */
    async setThreads(threads, options) {
        requireThreads(threads, 'setThreads: threads');
        const signal = readSignal('setThreads', options);
        // Only stores the count, so it runs on the JS thread at this call's turn.
        return enqueue(this, () => {
            const handle = ensureHandle(this);
            const native = loadBinding();
            native.idx_set_threads(handle, threads);
            this[THREADS] = native.idx_threads(handle);
        }, signal);
    }
    /**
     * Write a fresh snapshot and reset its matching v4 delta log. A
     * PartialCompact error means replacement occurred but durability or log
     * reset could not be confirmed. TurboVec storage does not support delta
     * compaction and is rejected with `InvalidArgument`.
     */
    async compactDelta(snapshotPath, deltaPath, options) {
        requireNonEmptyPath(snapshotPath, 'compactDelta: snapshotPath');
        requireNonEmptyPath(deltaPath, 'compactDelta: deltaPath');
        const signal = readSignal('compactDelta', options);
        return enqueue(this, (token) => this.mutate(() => loadBinding().idx_compact_delta_async(ensureHandle(this), snapshotPath, deltaPath, token)), signal);
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
    async setStagedSearch(enabled, options) {
        if (typeof enabled !== 'boolean') {
            throw new TypeError('setStagedSearch: enabled must be a boolean');
        }
        const signal = readSignal('setStagedSearch', options);
        return enqueue(this, async (token) => {
            await loadBinding().idx_set_staged_async(ensureHandle(this), enabled, token);
            this[STAGED] = enabled;
        }, signal);
    }
    /** Number of live entries after the last call that finished. */
    get length() {
        ensureHandle(this);
        return this[LENGTH];
    }
    /** Vector dimensionality. */
    get dim() {
        ensureHandle(this);
        return this[DIM];
    }
    /** Effective storage bit width. */
    get bitWidth() {
        ensureHandle(this);
        return this[BIT_WIDTH];
    }
    /** Storage mode; unlike `bitWidth`, tells TurboVec q4 from generic q4. */
    get storage() {
        ensureHandle(this);
        return this[STORAGE];
    }
    /** Threads the index's calls may use, as of the last `setThreads()` that finished. */
    get threads() {
        ensureHandle(this);
        return this[THREADS];
    }
    /**
     * Whether this is a TurboVec index loaded from a v3 snapshot of an earlier
     * release. It keeps that encoding and writes v3, and supports neither
     * `sync()` nor `toBytes()`.
     */
    get legacy() {
        ensureHandle(this);
        return this[LEGACY];
    }
    /**
     * Byte length of the snapshot `toBytes()` would return, as of the last call
     * that finished, computed without serializing. 0 for indexes `toBytes()`
     * rejects: non-TurboVec storages and legacy TurboVec indexes.
     */
    get serializedSize() {
        ensureHandle(this);
        return this[SERIALIZED_SIZE];
    }
    /**
     * Whether a TurboVec index holds a TQ+ calibration, as of the last call
     * that finished. A fresh TurboVec index calibrates from its first
     * `addWithIds()` batch when that batch has at least 1,000 rows; other
     * storages are never calibrated.
     */
    get calibrated() {
        ensureHandle(this);
        return this[CALIBRATED];
    }
    /**
     * Whether staged search is turned on, as of the last `setStagedSearch()`
     * that finished. Off for every new or loaded index. Reports the setting,
     * not whether a search runs in stages: see `setStagedSearch()`.
     */
    get stagedSearch() {
        ensureHandle(this);
        return this[STAGED];
    }
    /**
     * Release filters and native index resources. The index cannot be used
     * after this call, and calls that have not started reject. A call that is
     * running finishes first; the native index is freed after it. Resolves
     * once the native index has been freed, and rejects if freeing it fails.
     * This operation is idempotent.
     */
    dispose() {
        const handle = this[HANDLE];
        if (handle === null) {
            return this[QUEUE].then(swallow);
        }
        this.disposeFilters(false);
        this[HANDLE] = null;
        return releaseAfterQueue(this, () => loadBinding().idx_dispose(handle));
    }
    // Frees every prepared filter. `now` is for a call's own turn in the queue,
    // when no worker holds the index; otherwise each free waits its turn.
    disposeFilters(now) {
        for (const ref of this[FILTERS]) {
            const filter = ref.deref();
            if (filter === undefined) {
                continue;
            }
            if (!now) {
                // The caller learns of a failed free from the filter's own dispose().
                filter.dispose().catch(swallow);
                continue;
            }
            const detached = detachFilter(filter);
            if (detached !== null) {
                loadBinding().idx_filter_dispose(detached.filterHandle);
            }
        }
        this[FILTERS].clear();
    }
    // Reads the cached state back from the native index. Called at a turn in
    // the queue, or before the index is shared, when no worker holds it.
    readState() {
        const handle = this[HANDLE];
        if (handle === null) {
            return;
        }
        const native = loadBinding();
        this[DIM] = native.idx_dim(handle);
        this[BIT_WIDTH] = native.idx_bit_width(handle);
        this[LENGTH] = native.idx_len(handle);
        this[CALIBRATED] = native.idx_calibrated(handle);
        this[STAGED] = native.idx_staged(handle);
        this[THREADS] = native.idx_threads(handle);
        this[STORAGE] = native.idx_storage(handle);
        this[LEGACY] = native.idx_legacy(handle);
        this[SERIALIZED_SIZE] = native.idx_serialized_size(handle);
    }
    // After a mutation: prepared filters no longer match the index, and the
    // cached state may have changed.
    afterMutation() {
        this.disposeFilters(true);
        this.readState();
    }
    // Runs a native mutation, then invalidates prepared filters whether or not
    // it succeeded: a failed mutation may still have changed the index.
    async mutate(start) {
        try {
            return await start();
        }
        finally {
            this.afterMutation();
        }
    }
    registerFilter(handle) {
        const filter = createFilter(this, handle);
        this[FILTERS].add(filter[FILTER_REF]);
        if (this[FILTERS].size >= this[FILTERS_PRUNE_AT]) {
            this.pruneFilters();
            this[FILTERS_PRUNE_AT] = Math.max(MIN_FILTERS_PRUNE_AT, this[FILTERS].size * 2);
        }
        return filter;
    }
    pruneFilters() {
        for (const ref of this[FILTERS]) {
            if (ref.deref() === undefined) {
                this[FILTERS].delete(ref);
            }
        }
    }
    validateBatch(name, vectors, ids) {
        if (!(vectors instanceof Float32Array)) {
            throw new TypeError(`${name}: vectors must be a Float32Array`);
        }
        if (!(ids instanceof BigUint64Array)) {
            throw new TypeError(`${name}: ids must be a BigUint64Array`);
        }
        if (vectors.length !== ids.length * this.dim) {
            throw new RangeError(`${name}: vectors.length (${vectors.length}) must equal ids.length (${ids.length}) * dim (${this.dim})`);
        }
    }
    validateSearch(name, queries, k) {
        if (!(queries instanceof Float32Array)) {
            throw new TypeError(`${name}: queries must be a Float32Array`);
        }
        if (!isPositiveInt32(k)) {
            throw new TypeError(`${name}: k must be a positive int32`);
        }
    }
    validateId(name, id) {
        if (typeof id !== 'bigint') {
            throw new TypeError(`${name}: id must be a bigint`);
        }
    }
}
exports.default = IdMapIndex;
exports.IdMapIndex = IdMapIndex;
const cjsExports = IdMapIndex;
cjsExports.default = IdMapIndex;
cjsExports.IdMapIndex = IdMapIndex;
cjsExports.IdMapIndexFilter = IdMapIndexFilter;
module.exports = cjsExports;
