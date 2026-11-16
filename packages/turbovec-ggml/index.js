"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdMapIndex = exports.IdMapIndexFilter = void 0;
const HANDLE = Symbol('IdMapIndex.handle');
const FILTER_HANDLE = Symbol('IdMapIndexFilter.handle');
const FILTER_OWNER = Symbol('IdMapIndexFilter.owner');
const FILTER_REF = Symbol('IdMapIndexFilter.ref');
const FILTERS = Symbol('IdMapIndex.filters');
const FILTERS_PRUNE_AT = Symbol('IdMapIndex.filtersPruneAt');
const QUEUE = Symbol('IdMapIndex.queue');
const PENDING = Symbol('IdMapIndex.pending');
const DIM = Symbol('IdMapIndex.dim');
const BIT_WIDTH = Symbol('IdMapIndex.bitWidth');
const INT32_MAX = 0x7fffffff;
// Dropped filters leave dead WeakRefs behind. Pruning once the set doubles
// keeps prepareFilter amortized O(1) instead of rescanning on every call.
const MIN_FILTERS_PRUNE_AT = 64;
const BIT_WIDTH_BY_STORAGE = {
    f32: 32,
    q8: 8,
    q4: 4,
    'turbovec-q4': 4,
    'turbovec-q2': 2
};
const STORAGE_BY_BIT_WIDTH = {
    2: 'turbovec-q2',
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
function releaseFilter(owner, filter) {
    const ref = filter[FILTER_REF];
    if (ref !== null) {
        owner[FILTERS].delete(ref);
    }
}
function isPositiveInt32(value) {
    return Number.isInteger(value) && value > 0 && value <= INT32_MAX;
}
function isNonNegativeInt32(value) {
    return Number.isInteger(value) && value >= 0 && value <= INT32_MAX;
}
function requireNonEmptyPath(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}
function ensureHandle(index) {
    const handle = index[HANDLE];
    if (handle === null) {
        throw new Error('IdMapIndex has been disposed');
    }
    return handle;
}
// Sync calls are rejected while async work is queued or running: fabric
// would block the JS thread on the index lock until that work finished, and
// the call would run out of order with it.
function ensureIdleHandle(index) {
    const handle = ensureHandle(index);
    if (index[PENDING] > 0) {
        throw new Error('IdMapIndex has async operations in progress; await them before calling a sync method');
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
// Runs async operations on one index one at a time, in call order. On an
// idle index `run` starts now, so the native job holds the index before the
// caller's next statement (a `dispose()` right after lets it finish);
// otherwise it starts when every earlier operation has settled. The pending
// count drops before the caller's own continuation runs, so code that
// awaited the last operation can use the sync API straight away.
function enqueue(index, run) {
    ensureHandle(index);
    const result = index[PENDING] === 0 ? startNow(run) : index[QUEUE].then(run);
    index[PENDING] += 1;
    const settled = () => {
        index[PENDING] -= 1;
    };
    index[QUEUE] = result.then(settled, settled);
    return result;
}
// The native call copies its array inputs when it starts. An operation that
// waits behind earlier ones starts later, so its inputs are copied here, at
// call time: the caller may change or transfer them once the call returns.
// Must be called in the same synchronous step as the `enqueue()` it feeds.
function snapshot(index, array) {
    return index[PENDING] === 0 ? array : array.slice();
}
// Frees a native handle once the operations queued on `owner` have settled,
// or now when none are. An operation that is running holds the handle.
function releaseAfterQueue(owner, release) {
    if (owner[PENDING] === 0) {
        release();
        return;
    }
    owner[QUEUE] = owner[QUEUE].then(release).then(swallow, swallow);
}
function normalizeStorageOptions(options) {
    const { bitWidth, storage } = options;
    if (storage !== undefined) {
        if (typeof storage !== 'string' ||
            !Object.prototype.hasOwnProperty.call(BIT_WIDTH_BY_STORAGE, storage)) {
            throw new TypeError("IdMapIndex: storage must be 'f32', 'q8', 'q4', 'turbovec-q4', or 'turbovec-q2'");
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
        throw new TypeError('IdMapIndex: bitWidth must be 2, 4, 8, or 32');
    }
    return STORAGE_BY_BIT_WIDTH[width];
}
class IdMapIndexFilter {
    [FILTER_HANDLE] = null;
    [FILTER_OWNER] = null;
    [FILTER_REF] = null;
    constructor() {
        throw new TypeError('IdMapIndexFilter instances must be created by IdMapIndex.prepareFilter()');
    }
    /** Search with this prepared allowlist. Mutating the owner invalidates the filter. */
    search(queries, k) {
        validateFilterSearch('IdMapIndexFilter.search', queries, k);
        const owner = this[FILTER_OWNER];
        const filterHandle = this[FILTER_HANDLE];
        if (owner === null || filterHandle === null) {
            throw new Error('IdMapIndexFilter has been disposed');
        }
        return loadBinding().idx_search_prepared_filtered(ensureIdleHandle(owner), filterHandle, queries, k);
    }
    /**
     * `search()` run off the JS thread, queued behind the owner's other async
     * operations. Rejects when a mutation queued before it disposed the filter.
     */
    async searchAsync(queries, k) {
        validateFilterSearch('IdMapIndexFilter.searchAsync', queries, k);
        const owner = this[FILTER_OWNER];
        if (owner === null || this[FILTER_HANDLE] === null) {
            throw new Error('IdMapIndexFilter has been disposed');
        }
        const input = snapshot(owner, queries);
        return enqueue(owner, () => {
            const filterHandle = this[FILTER_HANDLE];
            if (this[FILTER_OWNER] === null || filterHandle === null) {
                throw new Error('IdMapIndexFilter has been disposed');
            }
            return loadBinding().idx_search_prepared_filtered_async(ensureHandle(owner), filterHandle, input, k);
        });
    }
    /**
     * Release the prepared native filter. This operation is idempotent. While
     * the owner has async operations queued, the native filter is freed after
     * they settle.
     */
    dispose() {
        const filterHandle = this[FILTER_HANDLE];
        if (filterHandle === null) {
            return;
        }
        const owner = this[FILTER_OWNER];
        this[FILTER_HANDLE] = null;
        this[FILTER_OWNER] = null;
        if (owner !== null) {
            releaseFilter(owner, this);
            releaseAfterQueue(owner, () => loadBinding().idx_filter_dispose(filterHandle));
        }
        else {
            loadBinding().idx_filter_dispose(filterHandle);
        }
        this[FILTER_REF] = null;
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
    return filter;
}
/**
 * CPU vector index with fixed dimensionality and stable uint64 external IDs.
 * Search uses exact or approximate dot products depending on storage. Callers
 * wanting cosine similarity should L2-normalize vectors before insertion and
 * queries before search. TurboVec normalizes indexed vectors while quantizing,
 * then restores their magnitude with a per-vector scale; it does not normalize
 * queries.
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
    // Fixed for the life of the index. Kept in JS so validating an async call
    // never has to reach the native index while another call holds it.
    [DIM] = 0;
    [BIT_WIDTH] = 8;
    constructor(options) {
        const { dim } = options ?? {};
        if (!isPositiveInt32(dim)) {
            throw new TypeError('IdMapIndex: dim must be a positive int32');
        }
        const storage = normalizeStorageOptions(options);
        if (storage.startsWith('turbovec-') && (dim > 16_384 || dim % 8 !== 0)) {
            throw new RangeError('IdMapIndex: TurboVec dim must be divisible by 8 and no greater than 16384');
        }
        const handle = loadBinding().idx_create({ dim, storage });
        this[HANDLE] = handle;
        this[DIM] = dim;
        this[BIT_WIDTH] = loadBinding().idx_bit_width(handle);
    }
    static load(path) {
        requireNonEmptyPath(path, 'IdMapIndex.load: path');
        return IdMapIndex.fromHandle(this, loadBinding().idx_load(path));
    }
    static loadMmap(path) {
        requireNonEmptyPath(path, 'IdMapIndex.loadMmap: path');
        return IdMapIndex.fromHandle(this, loadBinding().idx_load_mmap(path));
    }
    static loadWithDelta(snapshotPath, deltaPath) {
        requireNonEmptyPath(snapshotPath, 'IdMapIndex.loadWithDelta: snapshotPath');
        requireNonEmptyPath(deltaPath, 'IdMapIndex.loadWithDelta: deltaPath');
        return IdMapIndex.fromHandle(this, loadBinding().idx_load_with_delta(snapshotPath, deltaPath));
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
        instance[DIM] = loadBinding().idx_dim(handle);
        instance[BIT_WIDTH] = loadBinding().idx_bit_width(handle);
        return instance;
    }
    static async loadAsync(path) {
        requireNonEmptyPath(path, 'IdMapIndex.loadAsync: path');
        return IdMapIndex.fromHandle(this, await loadBinding().idx_load_async(path));
    }
    static async loadMmapAsync(path) {
        requireNonEmptyPath(path, 'IdMapIndex.loadMmapAsync: path');
        return IdMapIndex.fromHandle(this, await loadBinding().idx_load_mmap_async(path));
    }
    static async loadWithDeltaAsync(snapshotPath, deltaPath) {
        requireNonEmptyPath(snapshotPath, 'IdMapIndex.loadWithDeltaAsync: snapshotPath');
        requireNonEmptyPath(deltaPath, 'IdMapIndex.loadWithDeltaAsync: deltaPath');
        return IdMapIndex.fromHandle(this, await loadBinding().idx_load_with_delta_async(snapshotPath, deltaPath));
    }
    /**
     * Atomically add vectors with stable uint64 IDs. `vectors` is row-major and
     * must contain `ids.length * dim` finite components. TurboVec additionally
     * requires `abs(component) < 1e16`. UINT64_MAX is reserved.
     */
    addWithIds(vectors, ids) {
        this.validateBatch('addWithIds', vectors, ids);
        const handle = ensureIdleHandle(this);
        try {
            loadBinding().idx_add(handle, vectors, ids);
        }
        finally {
            this.disposeFilters();
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
    addLogged(vectors, ids, deltaPath) {
        this.validateBatch('addLogged', vectors, ids);
        requireNonEmptyPath(deltaPath, 'addLogged: deltaPath');
        const handle = ensureIdleHandle(this);
        try {
            loadBinding().idx_add_logged(handle, vectors, ids, deltaPath);
        }
        finally {
            this.disposeFilters();
        }
    }
    /**
     * Top-k similarity search over row-major queries. Results are sorted
     * by descending score, then ascending ID. TurboVec rotates queries without
     * normalizing them and performs approximate rotated/quantized dot-product
     * scoring. TurboVec query components require `abs(value) < 1e16`. Short rows
     * use UINT64_MAX padding.
     */
    search(queries, k) {
        this.validateSearch('search', queries, k);
        return loadBinding().idx_search(ensureIdleHandle(this), queries, k);
    }
    /** Exact search restricted to the supplied external IDs. */
    searchFiltered(queries, k, allowedIds) {
        this.validateSearch('searchFiltered', queries, k);
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError('searchFiltered: allowedIds must be a BigUint64Array');
        }
        return loadBinding().idx_search_filtered(ensureIdleHandle(this), queries, k, allowedIds);
    }
    /**
     * Prepare an allowlist for repeated searches. Native mutation attempts
     * invalidate all prepared filters created from this index. Call `dispose()`
     * when done to release native filter memory promptly; dropped filters are
     * reclaimed by GC.
     */
    prepareFilter(allowedIds) {
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError('prepareFilter: allowedIds must be a BigUint64Array');
        }
        return this.registerFilter(loadBinding().idx_filter_create(ensureIdleHandle(this), allowedIds));
    }
    /**
     * Build deterministic in-memory IVF-flat search state. Mutations invalidate
     * it, and snapshots do not persist it.
     */
    buildIvf(nLists, nIter = 0) {
        if (!isPositiveInt32(nLists)) {
            throw new TypeError('buildIvf: nLists must be a positive int32');
        }
        if (!isNonNegativeInt32(nIter)) {
            throw new TypeError('buildIvf: nIter must be a non-negative int32');
        }
        loadBinding().idx_build_ivf(ensureIdleHandle(this), nLists, nIter);
    }
    /**
     * Search the IVF-flat candidate lists. `buildIvf()` must have run after the
     * latest mutation or load. Higher `nProbe` generally improves recall.
     */
    searchIvf(queries, k, nProbe) {
        this.validateSearch('searchIvf', queries, k);
        if (!isPositiveInt32(nProbe)) {
            throw new TypeError('searchIvf: nProbe must be a positive int32');
        }
        return loadBinding().idx_search_ivf(ensureIdleHandle(this), queries, k, nProbe);
    }
    /** Remove an ID, returning false when it is not present. */
    remove(id) {
        this.validateId('remove', id);
        const removed = loadBinding().idx_remove(ensureIdleHandle(this), id);
        if (removed) {
            this.disposeFilters();
        }
        return removed;
    }
    /**
     * Remove an ID and append a durable v4 delta record. Returns false when the
     * ID is absent. Stale-writer catch-up may still mutate the handle when this
     * method returns false or throws, and a complete record may remain applied
     * after a durability error. The same binding and reload rules as
     * `addLogged()` apply.
     */
    removeLogged(id, deltaPath) {
        this.validateId('removeLogged', id);
        requireNonEmptyPath(deltaPath, 'removeLogged: deltaPath');
        const handle = ensureIdleHandle(this);
        try {
            return loadBinding().idx_remove_logged(handle, id, deltaPath);
        }
        finally {
            this.disposeFilters();
        }
    }
    /** Physically reclaim tombstoned slots. Rejected on delta-bound handles. */
    compact() {
        const handle = ensureIdleHandle(this);
        try {
            loadBinding().idx_compact(handle);
        }
        finally {
            this.disposeFilters();
        }
    }
    /** Return whether the index contains an external ID. */
    contains(id) {
        this.validateId('contains', id);
        return loadBinding().idx_contains(ensureIdleHandle(this), id);
    }
    /** Best-effort warmup of TurboVec rotation and codebook state. */
    prepare() {
        loadBinding().idx_prepare(ensureIdleHandle(this));
    }
    /**
     * Persist a checksummed v2 snapshot for f32/q4/q8, or a v8 snapshot for
     * TurboVec (v3 for an index loaded from a v3 snapshot). Delta-bound handles
     * must use `compactDelta()`. A NotDurable error means replacement succeeded
     * but parent-directory durability was not confirmed.
     */
    write(path) {
        requireNonEmptyPath(path, 'write: path');
        loadBinding().idx_write(ensureIdleHandle(this), path);
    }
    /**
     * Write a fresh snapshot and reset its matching v4 delta log. A
     * PartialCompact error means replacement occurred but durability or log
     * reset could not be confirmed. TurboVec storage does not support delta
     * compaction and is rejected with `InvalidArgument`.
     */
    compactDelta(snapshotPath, deltaPath) {
        requireNonEmptyPath(snapshotPath, 'compactDelta: snapshotPath');
        requireNonEmptyPath(deltaPath, 'compactDelta: deltaPath');
        const handle = ensureIdleHandle(this);
        try {
            loadBinding().idx_compact_delta(handle, snapshotPath, deltaPath);
        }
        finally {
            this.disposeFilters();
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
    async addWithIdsAsync(vectors, ids) {
        this.validateBatch('addWithIdsAsync', vectors, ids);
        const rows = snapshot(this, vectors);
        const keys = snapshot(this, ids);
        return enqueue(this, () => this.mutate(() => loadBinding().idx_add_async(ensureHandle(this), rows, keys)));
    }
    /** `addLogged()` run off the JS thread. */
    async addLoggedAsync(vectors, ids, deltaPath) {
        this.validateBatch('addLoggedAsync', vectors, ids);
        requireNonEmptyPath(deltaPath, 'addLoggedAsync: deltaPath');
        const rows = snapshot(this, vectors);
        const keys = snapshot(this, ids);
        return enqueue(this, () => this.mutate(() => loadBinding().idx_add_logged_async(ensureHandle(this), rows, keys, deltaPath)));
    }
    /** `search()` run off the JS thread. */
    async searchAsync(queries, k) {
        this.validateSearch('searchAsync', queries, k);
        const input = snapshot(this, queries);
        return enqueue(this, () => loadBinding().idx_search_async(ensureHandle(this), input, k));
    }
    /** `searchFiltered()` run off the JS thread. */
    async searchFilteredAsync(queries, k, allowedIds) {
        this.validateSearch('searchFilteredAsync', queries, k);
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError('searchFilteredAsync: allowedIds must be a BigUint64Array');
        }
        const input = snapshot(this, queries);
        const allowed = snapshot(this, allowedIds);
        return enqueue(this, () => loadBinding().idx_search_filtered_async(ensureHandle(this), input, k, allowed));
    }
    /** `prepareFilter()` run off the JS thread. */
    async prepareFilterAsync(allowedIds) {
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError('prepareFilterAsync: allowedIds must be a BigUint64Array');
        }
        const allowed = snapshot(this, allowedIds);
        return enqueue(this, async () => {
            const filterHandle = await loadBinding().idx_filter_create_async(ensureHandle(this), allowed);
            // dispose() ran while the filter was being built. Free the filter now,
            // while the index is still alive: fabric requires the index to outlive
            // its filters, and the index is freed once this operation settles.
            if (this[HANDLE] === null) {
                loadBinding().idx_filter_dispose(filterHandle);
                throw new Error('IdMapIndex has been disposed');
            }
            return this.registerFilter(filterHandle);
        });
    }
    /**
     * `buildIvf()` run off the JS thread. The build cannot be cancelled: once
     * it starts, it runs to the end.
     */
    async buildIvfAsync(nLists, nIter = 0) {
        if (!isPositiveInt32(nLists)) {
            throw new TypeError('buildIvfAsync: nLists must be a positive int32');
        }
        if (!isNonNegativeInt32(nIter)) {
            throw new TypeError('buildIvfAsync: nIter must be a non-negative int32');
        }
        return enqueue(this, () => loadBinding().idx_build_ivf_async(ensureHandle(this), nLists, nIter));
    }
    /** `searchIvf()` run off the JS thread. */
    async searchIvfAsync(queries, k, nProbe) {
        this.validateSearch('searchIvfAsync', queries, k);
        if (!isPositiveInt32(nProbe)) {
            throw new TypeError('searchIvfAsync: nProbe must be a positive int32');
        }
        const input = snapshot(this, queries);
        return enqueue(this, () => loadBinding().idx_search_ivf_async(ensureHandle(this), input, k, nProbe));
    }
    /** `remove()` run off the JS thread. */
    async removeAsync(id) {
        this.validateId('removeAsync', id);
        return enqueue(this, async () => {
            const removed = await loadBinding().idx_remove_async(ensureHandle(this), id);
            if (removed) {
                this.disposeFilters();
            }
            return removed;
        });
    }
    /** `removeLogged()` run off the JS thread. */
    async removeLoggedAsync(id, deltaPath) {
        this.validateId('removeLoggedAsync', id);
        requireNonEmptyPath(deltaPath, 'removeLoggedAsync: deltaPath');
        return enqueue(this, () => this.mutate(() => loadBinding().idx_remove_logged_async(ensureHandle(this), id, deltaPath)));
    }
    /** `compact()` run off the JS thread. */
    async compactAsync() {
        return enqueue(this, () => this.mutate(() => loadBinding().idx_compact_async(ensureHandle(this))));
    }
    /** `prepare()` run off the JS thread. */
    async prepareAsync() {
        return enqueue(this, () => loadBinding().idx_prepare_async(ensureHandle(this)));
    }
    /** `write()` run off the JS thread. */
    async writeAsync(path) {
        requireNonEmptyPath(path, 'writeAsync: path');
        return enqueue(this, () => loadBinding().idx_write_async(ensureHandle(this), path));
    }
    /** `compactDelta()` run off the JS thread. */
    async compactDeltaAsync(snapshotPath, deltaPath) {
        requireNonEmptyPath(snapshotPath, 'compactDeltaAsync: snapshotPath');
        requireNonEmptyPath(deltaPath, 'compactDeltaAsync: deltaPath');
        return enqueue(this, () => this.mutate(() => loadBinding().idx_compact_delta_async(ensureHandle(this), snapshotPath, deltaPath)));
    }
    /** Number of live entries. */
    get length() {
        return loadBinding().idx_len(ensureIdleHandle(this));
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
    /**
     * Whether a TurboVec index holds a TQ+ calibration. A fresh TurboVec index
     * calibrates from its first `addWithIds()` batch when that batch has at
     * least 1,000 rows; other storages are never calibrated.
     */
    get calibrated() {
        return loadBinding().idx_calibrated(ensureIdleHandle(this));
    }
    /**
     * Whether staged search is turned on. Off for every new or loaded index.
     * Reports the setting, not whether a search runs in stages: see
     * `setStagedSearch()`.
     */
    get stagedSearch() {
        return loadBinding().idx_staged(ensureIdleHandle(this));
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
    setStagedSearch(enabled) {
        if (typeof enabled !== 'boolean') {
            throw new TypeError('setStagedSearch: enabled must be a boolean');
        }
        loadBinding().idx_set_staged(ensureIdleHandle(this), enabled);
    }
    /**
     * Release filters and native index resources. This operation is
     * idempotent. Async operations that have not started yet reject; one that
     * is running finishes first, and the native index is freed after it.
     */
    dispose() {
        const handle = this[HANDLE];
        if (handle === null) {
            return;
        }
        this.disposeFilters();
        this[HANDLE] = null;
        releaseAfterQueue(this, () => loadBinding().idx_dispose(handle));
    }
    /** `dispose()`, resolving once the native index has been freed. */
    async disposeAsync() {
        this.dispose();
        await this[QUEUE];
    }
    disposeFilters() {
        for (const ref of this[FILTERS]) {
            ref.deref()?.dispose();
        }
        this[FILTERS].clear();
    }
    // Runs a native mutation, then invalidates prepared filters whether or not
    // it succeeded, as the sync mutations do.
    async mutate(start) {
        try {
            return await start();
        }
        finally {
            this.disposeFilters();
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
