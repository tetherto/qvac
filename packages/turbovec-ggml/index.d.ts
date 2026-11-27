declare const HANDLE: unique symbol;
declare const FILTER_HANDLE: unique symbol;
declare const FILTER_OWNER: unique symbol;
declare const FILTER_REF: unique symbol;
declare const FILTER_RELEASED: unique symbol;
declare const FILTERS: unique symbol;
declare const FILTERS_PRUNE_AT: unique symbol;
declare const QUEUE: unique symbol;
declare const PENDING: unique symbol;
declare const DIM: unique symbol;
declare const BIT_WIDTH: unique symbol;
declare const LENGTH: unique symbol;
declare const CALIBRATED: unique symbol;
declare const STAGED: unique symbol;
declare const THREADS: unique symbol;
declare const STORAGE: unique symbol;
declare const LEGACY: unique symbol;
declare const SERIALIZED_SIZE: unique symbol;
declare const BIT_WIDTH_BY_STORAGE: {
    readonly f32: 32;
    readonly q8: 8;
    readonly q4: 4;
    readonly 'turbovec-q4': 4;
    readonly 'turbovec-q3': 3;
    readonly 'turbovec-q2': 2;
};
type NativeHandle = object;
export type IdMapIndexBitWidth = 2 | 3 | 4 | 8 | 32;
export type IdMapIndexStorage = keyof typeof BIT_WIDTH_BY_STORAGE;
export interface IdMapIndexOptions {
    /**
     * Vector dimensionality. TurboVec requires a 64-bit target and a dimension
     * divisible by 8 and no greater than 16,384.
     */
    dim: number;
    /**
     * 2 = TurboVec q2, 3 = TurboVec q3, 4 = q4, 8 = q8, and 32 = full f32
     * storage. Defaults to 8.
     */
    bitWidth?: IdMapIndexBitWidth;
    /** Use `turbovec-q4` to distinguish TurboVec q4 from generic q4 storage. */
    storage?: IdMapIndexStorage;
    /** Worker threads for the index's calls; see `setThreads()`. Defaults to 1. */
    threads?: number;
}
/**
 * The parts of an `AbortSignal` the index uses. Signals from the DOM, Node
 * and `bare-abort-controller` all fit.
 */
export interface IdMapIndexAbortSignal {
    readonly aborted: boolean;
    readonly reason?: unknown;
    addEventListener(type: 'abort', listener: () => void, options?: {
        once?: boolean;
    }): void;
    removeEventListener(type: 'abort', listener: () => void): void;
}
export interface IdMapIndexCallOptions {
    /**
     * Cancels the call. A call that has not started is skipped. A call that is
     * running rejects at once, but its native work runs to the end: a search's
     * result is dropped, while a mutation such as `addWithIds()` or
     * `buildIvf()` still takes effect. Later calls on the index wait for that
     * work. The promise rejects with `signal.reason`.
     */
    signal?: IdMapIndexAbortSignal;
}
export interface IdMapIndexWriteOptions extends IdMapIndexCallOptions {
    /**
     * `durable` (the default) fsyncs the snapshot and its directory before
     * resolving. `fast`, for TurboVec storage only, skips both fsyncs: the
     * file is still replaced atomically and survives a process crash, but a
     * power loss soon after may lose it. Other storages reject `fast` with
     * `InvalidArgument`, since a delta log could start from the snapshot.
     */
    durability?: 'durable' | 'fast';
}
export interface IdMapIndexSearchResult {
    /**
     * Row-major similarity scores. f32/q4/q8 use dot products against stored or
     * dequantized vectors. TurboVec uses rotated/quantized storage with a
     * per-vector scale and rotated queries to approximate dot products. Higher
     * scores are closer.
     */
    scores: Float32Array;
    /** Row-major external IDs. UINT64_MAX is used to pad short result rows. */
    ids: BigUint64Array;
    /** Number of query rows. */
    m: number;
    /** Requested result count per query. */
    k: number;
}
export declare class IdMapIndexFilter {
    [FILTER_HANDLE]: NativeHandle | null;
    [FILTER_OWNER]: IdMapIndex | null;
    [FILTER_REF]: WeakRef<IdMapIndexFilter> | null;
    [FILTER_RELEASED]: Promise<void>;
    private constructor();
    /**
     * Search with this prepared allowlist, queued behind the owner's other
     * operations. Rejects when an earlier mutation of the owner disposed the
     * filter: every mutation invalidates the owner's filters.
     */
    search(queries: Float32Array, k: number, options?: IdMapIndexCallOptions): Promise<IdMapIndexSearchResult>;
    /**
     * Release the prepared native filter. The filter cannot be used after this
     * call. While the owner has operations queued, the native filter is freed
     * after they settle. Resolves once the native filter has been freed, and
     * rejects if freeing it fails. This operation is idempotent: a later call
     * returns the same promise.
     */
    dispose(): Promise<void>;
}
type IdMapIndexClass<T extends IdMapIndex> = (abstract new (...args: never[]) => T) & {
    prototype: T;
};
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
    static Filter: typeof IdMapIndexFilter;
    static IdMapIndex: typeof IdMapIndex;
    static IdMapIndexFilter: typeof IdMapIndexFilter;
    [HANDLE]: NativeHandle | null;
    [FILTERS]: Set<WeakRef<IdMapIndexFilter>>;
    [FILTERS_PRUNE_AT]: number;
    [QUEUE]: Promise<unknown>;
    [PENDING]: number;
    [DIM]: number;
    [BIT_WIDTH]: IdMapIndexBitWidth;
    [LENGTH]: number;
    [CALIBRATED]: boolean;
    [STAGED]: boolean;
    [THREADS]: number;
    [STORAGE]: IdMapIndexStorage;
    [LEGACY]: boolean;
    [SERIALIZED_SIZE]: number;
    constructor(options: IdMapIndexOptions);
    /**
     * Load a v2/v3/v8 snapshot or migrate legacy v1 storage. Legacy bit-width 8
     * snapshots migrate to q8; other v1 widths migrate to f32. TurboVec v3
     * snapshots from earlier releases keep their encoding and keep writing v3;
     * those above 1,024 dimensions can be loaded and rewritten, but cannot add,
     * search, or build IVF state. Called on a subclass, resolves to an instance
     * of that subclass; its constructor and field initializers do not run. An
     * index that finishes loading after `signal` aborts is disposed.
     */
    static load<T extends IdMapIndex>(this: IdMapIndexClass<T>, path: string, options?: IdMapIndexCallOptions): Promise<T>;
    /** Detached call, e.g. `const { load } = IdMapIndex`. Resolves to an IdMapIndex. */
    static load(path: string, options?: IdMapIndexCallOptions): Promise<IdMapIndex>;
    /**
     * Load a v2 snapshot with read-only mmap-backed vectors. Legacy v1 and
     * TurboVec (v3 and v8) snapshots are rejected. Requires a little-endian host
     * and, on POSIX, a filesystem supporting flock(). Mutations are rejected.
     * Resolves to a subclass instance when called on a subclass, as `load()`
     * does.
     */
    static loadMmap<T extends IdMapIndex>(this: IdMapIndexClass<T>, path: string, options?: IdMapIndexCallOptions): Promise<T>;
    /** Detached call, e.g. `const { loadMmap } = IdMapIndex`. Resolves to an IdMapIndex. */
    static loadMmap(path: string, options?: IdMapIndexCallOptions): Promise<IdMapIndex>;
    /**
     * Load a snapshot and replay its append-only delta log. A missing log is
     * treated as empty. The returned index is bound to `deltaPath`; use logged
     * mutations and `compactDelta()` rather than plain mutations or `write()`.
     * Delta logs require a local filesystem with reliable cooperative locking.
     * TurboVec snapshots are rejected with `InvalidArgument`. Resolves to a
     * subclass instance when called on a subclass, as `load()` does.
     */
    static loadWithDelta<T extends IdMapIndex>(this: IdMapIndexClass<T>, snapshotPath: string, deltaPath: string, options?: IdMapIndexCallOptions): Promise<T>;
    /** Detached call, e.g. `const { loadWithDelta } = IdMapIndex`. Resolves to an IdMapIndex. */
    static loadWithDelta(snapshotPath: string, deltaPath: string, options?: IdMapIndexCallOptions): Promise<IdMapIndex>;
    /**
     * Load a TurboVec snapshot from the bytes `toBytes()` returns, or from the
     * contents of a TurboVec v8 snapshot file. Other snapshots, including v3,
     * are rejected. The bytes are copied when the call is made. Loads with
     * staged search off and 1 thread, as `load()` does. Resolves to a subclass
     * instance when called on a subclass, as `load()` does.
     */
    static fromBytes<T extends IdMapIndex>(this: IdMapIndexClass<T>, bytes: Uint8Array, options?: IdMapIndexCallOptions): Promise<T>;
    /** Detached call, e.g. `const { fromBytes } = IdMapIndex`. Resolves to an IdMapIndex. */
    static fromBytes(bytes: Uint8Array, options?: IdMapIndexCallOptions): Promise<IdMapIndex>;
    private static startLoad;
    private static fromHandle;
    /**
     * Atomically add vectors with stable uint64 IDs. `vectors` is row-major and
     * must contain `ids.length * dim` finite components. TurboVec additionally
     * requires `abs(component) < 1e16`. UINT64_MAX is reserved.
     */
    addWithIds(vectors: Float32Array, ids: BigUint64Array, options?: IdMapIndexCallOptions): Promise<void>;
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
    addLogged(vectors: Float32Array, ids: BigUint64Array, deltaPath: string, options?: IdMapIndexCallOptions): Promise<void>;
    /**
     * Top-k similarity search over row-major queries. Results are sorted
     * by descending score, then ascending ID; TurboVec orders equal scores by
     * stored row, which removals and `buildIvf()` reshuffle. TurboVec rotates
     * queries without normalizing them and performs approximate rotated/quantized
     * dot-product scoring. TurboVec query components require
     * `abs(value) < 1e16`. Short rows use UINT64_MAX padding.
     */
    search(queries: Float32Array, k: number, options?: IdMapIndexCallOptions): Promise<IdMapIndexSearchResult>;
    /** Exact search restricted to the supplied external IDs. */
    searchFiltered(queries: Float32Array, k: number, allowedIds: BigUint64Array, options?: IdMapIndexCallOptions): Promise<IdMapIndexSearchResult>;
    /**
     * Prepare an allowlist for repeated searches. Native mutation attempts and
     * `buildIvf()` invalidate all prepared filters created from this index. Call
     * `dispose()` when done to release native filter memory promptly; dropped
     * filters are reclaimed by GC. A filter that finishes after `signal` aborts
     * is disposed.
     */
    prepareFilter(allowedIds: BigUint64Array, options?: IdMapIndexCallOptions): Promise<IdMapIndexFilter>;
    /**
     * Build deterministic in-memory IVF-flat search state. Mutations invalidate
     * it, and snapshots do not persist it. Disposes every prepared filter, as a
     * mutation does: on TurboVec storage the build regroups the rows by IVF list.
     * A build that has started runs to the end even when `signal` aborts.
     */
    buildIvf(nLists: number, nIter?: number, options?: IdMapIndexCallOptions): Promise<void>;
    /**
     * Search the IVF-flat candidate lists. `buildIvf()` must have run after the
     * latest mutation or load. Higher `nProbe` generally improves recall.
     */
    searchIvf(queries: Float32Array, k: number, nProbe: number, options?: IdMapIndexCallOptions): Promise<IdMapIndexSearchResult>;
    /** Remove an ID, resolving to false when it is not present. */
    remove(id: bigint, options?: IdMapIndexCallOptions): Promise<boolean>;
    /**
     * Remove an ID and append a durable v4 delta record. Resolves to false when
     * the ID is absent. Stale-writer catch-up may still mutate the index when
     * this resolves to false or rejects, and a complete record may remain
     * applied after a durability error. The same binding and reload rules as
     * `addLogged()` apply.
     */
    removeLogged(id: bigint, deltaPath: string, options?: IdMapIndexCallOptions): Promise<boolean>;
    /** Physically reclaim tombstoned slots. Rejected on delta-bound indexes. */
    compact(options?: IdMapIndexCallOptions): Promise<void>;
    /** Resolve to whether the index contains an external ID. */
    contains(id: bigint, options?: IdMapIndexCallOptions): Promise<boolean>;
    /** Best-effort warmup of TurboVec rotation and codebook state. */
    prepare(options?: IdMapIndexCallOptions): Promise<void>;
    /**
     * Persist a checksummed v2 snapshot for f32/q4/q8, or a v8 snapshot for
     * TurboVec (v3 for an index loaded from a v3 snapshot). Delta-bound indexes
     * must use `compactDelta()`. A NotDurable error means replacement succeeded
     * but parent-directory durability was not confirmed. See
     * {@link IdMapIndexWriteOptions} for `durability`.
     */
    write(path: string, options?: IdMapIndexWriteOptions): Promise<void>;
    /**
     * Save a TurboVec index to `path`, writing only what changed since its last
     * sync there. The first sync to a path, and the first after a calibration
     * or `buildIvf()`, writes the whole file. Each sync is durable, and a crash
     * at any point leaves the previous sync loadable. An index loaded from a
     * synced file keeps syncing to it incrementally. One index may sync to a
     * path at a time: when another `sync()` has changed the file, this rejects
     * with `IOError` and the file must be loaded again to continue. A snapshot
     * that `write()` or `toBytes()` produced claims no path, so a `sync()` over
     * one rewrites it whole, as upstream turbovec does. Rejects
     * with `InvalidArgument` for non-TurboVec storage and for an index loaded
     * from a v3 snapshot.
     */
    sync(path: string, options?: IdMapIndexCallOptions): Promise<void>;
    /**
     * The bytes `write()` would put in a TurboVec snapshot file, for storing
     * an index somewhere other than a file. Load them with
     * `IdMapIndex.fromBytes()`. Rejects with `InvalidArgument` for non-TurboVec
     * storage and for an index loaded from a v3 snapshot.
     */
    toBytes(options?: IdMapIndexCallOptions): Promise<Uint8Array>;
    /**
     * All live IDs. The order is stable until the index changes, and on
     * TurboVec storage until `buildIvf()`.
     */
    ids(options?: IdMapIndexCallOptions): Promise<BigUint64Array>;
    /**
     * Set how many threads the calls queued after this one may use, from 1
     * (the default) to 256, the addon's worker thread included. Searches,
     * adds and TurboVec calibration split their work across them; results do
     * not depend on the count. The extra threads come from one pool shared by
     * every index in the process. Not saved in snapshots: a loaded index
     * starts at 1.
     */
    setThreads(threads: number, options?: IdMapIndexCallOptions): Promise<void>;
    /**
     * Write a fresh snapshot and reset its matching v4 delta log. A
     * PartialCompact error means replacement occurred but durability or log
     * reset could not be confirmed. TurboVec storage does not support delta
     * compaction and is rejected with `InvalidArgument`.
     */
    compactDelta(snapshotPath: string, deltaPath: string, options?: IdMapIndexCallOptions): Promise<void>;
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
    setStagedSearch(enabled: boolean, options?: IdMapIndexCallOptions): Promise<void>;
    /** Number of live entries after the last call that finished. */
    get length(): number;
    /** Vector dimensionality. */
    get dim(): number;
    /** Effective storage bit width. */
    get bitWidth(): IdMapIndexBitWidth;
    /** Storage mode; unlike `bitWidth`, tells TurboVec q4 from generic q4. */
    get storage(): "turbovec-q2" | "turbovec-q3" | "q4" | "q8" | "f32" | "turbovec-q4";
    /** Threads the index's calls may use, as of the last `setThreads()` that finished. */
    get threads(): number;
    /**
     * Whether this is a TurboVec index loaded from a v3 snapshot of an earlier
     * release. It keeps that encoding and writes v3, and supports neither
     * `sync()` nor `toBytes()`.
     */
    get legacy(): boolean;
    /**
     * Byte length of the snapshot `toBytes()` would return, as of the last call
     * that finished, computed without serializing. 0 for indexes `toBytes()`
     * rejects: non-TurboVec storages and legacy TurboVec indexes.
     */
    get serializedSize(): number;
    /**
     * Whether a TurboVec index holds a TQ+ calibration, as of the last call
     * that finished. A fresh TurboVec index calibrates from its first
     * `addWithIds()` batch when that batch has at least 1,000 rows; other
     * storages are never calibrated.
     */
    get calibrated(): boolean;
    /**
     * Whether staged search is turned on, as of the last `setStagedSearch()`
     * that finished. Off for every new or loaded index. Reports the setting,
     * not whether a search runs in stages: see `setStagedSearch()`.
     */
    get stagedSearch(): boolean;
    /**
     * Release filters and native index resources. The index cannot be used
     * after this call, and calls that have not started reject. A call that is
     * running finishes first; the native index is freed after it. Resolves
     * once the native index has been freed, and rejects if freeing it fails.
     * This operation is idempotent.
     */
    dispose(): Promise<void>;
    private disposeFilters;
    private readState;
    private afterMutation;
    private mutate;
    private registerFilter;
    private pruneFilters;
    private validateBatch;
    private validateSearch;
    private validateId;
}
export { IdMapIndex };
