declare const HANDLE: unique symbol;
declare const FILTER_HANDLE: unique symbol;
declare const FILTER_OWNER: unique symbol;
declare const FILTERS: unique symbol;
declare const BIT_WIDTH_BY_STORAGE: {
    readonly f32: 32;
    readonly q8: 8;
    readonly q4: 4;
    readonly 'turbovec-q4': 4;
    readonly 'turbovec-q2': 2;
};
type NativeHandle = object;
export type IdMapIndexBitWidth = 2 | 4 | 8 | 32;
export type IdMapIndexStorage = keyof typeof BIT_WIDTH_BY_STORAGE;
export interface IdMapIndexOptions {
    /**
     * Vector dimensionality. TurboVec requires a 64-bit target and a dimension
     * divisible by 8 and no greater than 1,024.
     */
    dim: number;
    /** 2 = TurboVec q2, 4 = q4, 8 = q8, and 32 = full f32 storage. Defaults to 8. */
    bitWidth?: IdMapIndexBitWidth;
    /** Use `turbovec-q4` to distinguish TurboVec q4 from generic q4 storage. */
    storage?: IdMapIndexStorage;
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
    private constructor();
    /** Search with this prepared allowlist. Mutating the owner invalidates the filter. */
    search(queries: Float32Array, k: number): IdMapIndexSearchResult;
    /** Release the prepared native filter. This operation is idempotent. */
    dispose(): void;
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
    static Filter: typeof IdMapIndexFilter;
    static IdMapIndex: typeof IdMapIndex;
    static IdMapIndexFilter: typeof IdMapIndexFilter;
    [HANDLE]: NativeHandle | null;
    [FILTERS]: Set<WeakRef<IdMapIndexFilter>>;
    constructor(options: IdMapIndexOptions);
    /**
     * Load a v2/v3 snapshot or migrate legacy v1 storage. Legacy bit-width 8
     * snapshots migrate to q8; other v1 widths migrate to f32. Older TurboVec
     * snapshots above 1,024 dimensions can be loaded and rewritten, but cannot
     * add, search, or build IVF state. Synchronous and potentially blocking.
     */
    static load(path: string): IdMapIndex;
    /**
     * Load a v2 snapshot with read-only mmap-backed vectors. Legacy v1 and
     * TurboVec v3 snapshots are rejected. Requires a little-endian host and,
     * on POSIX, a filesystem supporting flock(). Mutations are rejected.
     */
    static loadMmap(path: string): IdMapIndex;
    /**
     * Load a snapshot and replay its append-only delta log. A missing log is
     * treated as empty. The returned handle is bound to `deltaPath`; use logged
     * mutations and `compactDelta()` rather than plain mutations or `write()`.
     * Delta logs require a local filesystem with reliable cooperative locking.
     * TurboVec snapshots are rejected with `InvalidArgument`.
     */
    static loadWithDelta(snapshotPath: string, deltaPath: string): IdMapIndex;
    private static fromHandle;
    /**
     * Atomically add vectors with stable uint64 IDs. `vectors` is row-major and
     * must contain `ids.length * dim` finite components. TurboVec additionally
     * requires `abs(component) < 1e16`. UINT64_MAX is reserved.
     */
    addWithIds(vectors: Float32Array, ids: BigUint64Array): void;
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
    addLogged(vectors: Float32Array, ids: BigUint64Array, deltaPath: string): void;
    /**
     * Top-k similarity search over row-major queries. Results are sorted
     * by descending score, then ascending ID. TurboVec rotates queries without
     * normalizing them and performs approximate rotated/quantized dot-product
     * scoring. TurboVec query components require `abs(value) < 1e16`. Short rows
     * use UINT64_MAX padding.
     */
    search(queries: Float32Array, k: number): IdMapIndexSearchResult;
    /** Exact search restricted to the supplied external IDs. */
    searchFiltered(queries: Float32Array, k: number, allowedIds: BigUint64Array): IdMapIndexSearchResult;
    /**
     * Prepare an allowlist for repeated searches. Native mutation attempts
     * invalidate all prepared filters created from this index. Call `dispose()`
     * when done to release native filter memory promptly; dropped filters are
     * reclaimed by GC.
     */
    prepareFilter(allowedIds: BigUint64Array): IdMapIndexFilter;
    /**
     * Build deterministic in-memory IVF-flat search state. Mutations invalidate
     * it, and snapshots do not persist it.
     */
    buildIvf(nLists: number, nIter?: number): void;
    /**
     * Search the IVF-flat candidate lists. `buildIvf()` must have run after the
     * latest mutation or load. Higher `nProbe` generally improves recall.
     */
    searchIvf(queries: Float32Array, k: number, nProbe: number): IdMapIndexSearchResult;
    /** Remove an ID, returning false when it is not present. */
    remove(id: bigint): boolean;
    /**
     * Remove an ID and append a durable v4 delta record. Returns false when the
     * ID is absent. Stale-writer catch-up may still mutate the handle when this
     * method returns false or throws, and a complete record may remain applied
     * after a durability error. The same binding and reload rules as
     * `addLogged()` apply.
     */
    removeLogged(id: bigint, deltaPath: string): boolean;
    /** Physically reclaim tombstoned slots. Rejected on delta-bound handles. */
    compact(): void;
    /** Return whether the index contains an external ID. */
    contains(id: bigint): boolean;
    /** Best-effort warmup of TurboVec rotation and codebook state. */
    prepare(): void;
    /**
     * Persist a checksummed v2 snapshot for f32/q4/q8 or v3 for TurboVec.
     * Delta-bound handles must use `compactDelta()`. A NotDurable error means
     * replacement succeeded but parent-directory durability was not confirmed.
     */
    write(path: string): void;
    /**
     * Write a fresh snapshot and reset its matching v4 delta log. A
     * PartialCompact error means replacement occurred but durability or log
     * reset could not be confirmed. TurboVec storage does not support delta
     * compaction and is rejected with `InvalidArgument`.
     */
    compactDelta(snapshotPath: string, deltaPath: string): void;
    /** Number of live entries. */
    get length(): number;
    /** Vector dimensionality. */
    get dim(): number;
    /** Effective storage bit width. */
    get bitWidth(): IdMapIndexBitWidth;
    /** Release filters and native index resources. This operation is idempotent. */
    dispose(): void;
    private disposeFilters;
    private pruneFilters;
    private validateBatch;
    private validateSearch;
    private validateId;
}
export { IdMapIndex };
