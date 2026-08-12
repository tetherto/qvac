declare const HANDLE: unique symbol;
declare const FILTER_HANDLE: unique symbol;
declare const FILTER_OWNER: unique symbol;
declare const FILTERS: unique symbol;
declare const BIT_WIDTH_BY_STORAGE: {
    readonly f32: 32;
    readonly q8: 8;
    readonly q4: 4;
    readonly "turbovec-q4": 4;
    readonly "turbovec-q2": 2;
};
type NativeHandle = object;
export type IdMapIndexBitWidth = 2 | 4 | 8 | 32;
export type IdMapIndexStorage = keyof typeof BIT_WIDTH_BY_STORAGE;
export interface IdMapIndexOptions {
    /**
     * Vector dimensionality. TurboVec requires a 64-bit target and a dimension
     * divisible by 8 and no greater than 65,536.
     */
    dim: number;
    /** 2 = TurboVec q2, 4 = q4, 8 = q8, and 32 = full f32 storage. Defaults to 8. */
    bitWidth?: IdMapIndexBitWidth;
    /** Use `turbovec-q4` to distinguish TurboVec q4 from generic q4 storage. */
    storage?: IdMapIndexStorage;
}
export interface IdMapIndexSearchResult {
    /** Row-major dot-product scores. Higher scores are closer. */
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
    search(queries: Float32Array, k: number): IdMapIndexSearchResult;
    dispose(): void;
}
/**
 * CPU vector index with fixed dimensionality and stable uint64 external IDs.
 * Search uses dot products; callers requiring cosine similarity should
 * L2-normalize vectors before insertion and querying.
 */
export default class IdMapIndex {
    static Filter: typeof IdMapIndexFilter;
    static IdMapIndex: typeof IdMapIndex;
    static IdMapIndexFilter: typeof IdMapIndexFilter;
    [HANDLE]: NativeHandle | null;
    [FILTERS]: Set<IdMapIndexFilter>;
    constructor(options: IdMapIndexOptions);
    static load(path: string): IdMapIndex;
    static loadMmap(path: string): IdMapIndex;
    static loadWithDelta(snapshotPath: string, deltaPath: string): IdMapIndex;
    private static fromHandle;
    addWithIds(vectors: Float32Array, ids: BigUint64Array): void;
    addLogged(vectors: Float32Array, ids: BigUint64Array, deltaPath: string): void;
    search(queries: Float32Array, k: number): IdMapIndexSearchResult;
    searchFiltered(queries: Float32Array, k: number, allowedIds: BigUint64Array): IdMapIndexSearchResult;
    prepareFilter(allowedIds: BigUint64Array): IdMapIndexFilter;
    buildIvf(nLists: number, nIter?: number): void;
    searchIvf(queries: Float32Array, k: number, nProbe: number): IdMapIndexSearchResult;
    remove(id: bigint): boolean;
    removeLogged(id: bigint, deltaPath: string): boolean;
    compact(): void;
    contains(id: bigint): boolean;
    prepare(): void;
    write(path: string): void;
    compactDelta(snapshotPath: string, deltaPath: string): void;
    get length(): number;
    get dim(): number;
    get bitWidth(): IdMapIndexBitWidth;
    dispose(): void;
    private validateBatch;
    private validateSearch;
    private validateId;
}
export { IdMapIndex };
