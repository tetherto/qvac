/* eslint-disable @typescript-eslint/no-require-imports -- The native Bare binding is resolved through CommonJS. */
const binding = require("./binding") as IdMapIndexBinding;
/* eslint-enable @typescript-eslint/no-require-imports */

const HANDLE = Symbol("IdMapIndex.handle");
const FILTER_HANDLE = Symbol("IdMapIndexFilter.handle");
const FILTER_OWNER = Symbol("IdMapIndexFilter.owner");
const FILTERS = Symbol("IdMapIndex.filters");
const INT32_MAX = 0x7fffffff;

const BIT_WIDTH_BY_STORAGE = {
  f32: 32,
  q8: 8,
  q4: 4,
  "turbovec-q4": 4,
  "turbovec-q2": 2,
} as const;

const STORAGE_BY_BIT_WIDTH = {
  2: "turbovec-q2",
  4: "q4",
  8: "q8",
  32: "f32",
} as const;

type NativeHandle = object;

interface IdMapIndexBinding {
  idx_create(options: Required<IdMapIndexOptions>): NativeHandle;
  idx_load(path: string): NativeHandle;
  idx_load_mmap(path: string): NativeHandle;
  idx_load_with_delta(snapshotPath: string, deltaPath: string): NativeHandle;
  idx_add(handle: NativeHandle, vectors: Float32Array, ids: BigUint64Array): void;
  idx_add_logged(
    handle: NativeHandle,
    vectors: Float32Array,
    ids: BigUint64Array,
    deltaPath: string,
  ): void;
  idx_search(handle: NativeHandle, queries: Float32Array, k: number): IdMapIndexSearchResult;
  idx_search_filtered(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    allowedIds: BigUint64Array,
  ): IdMapIndexSearchResult;
  idx_filter_create(handle: NativeHandle, allowedIds: BigUint64Array): NativeHandle;
  idx_search_prepared_filtered(
    handle: NativeHandle,
    filterHandle: NativeHandle,
    queries: Float32Array,
    k: number,
  ): IdMapIndexSearchResult;
  idx_build_ivf(handle: NativeHandle, nLists: number, nIter: number): void;
  idx_search_ivf(
    handle: NativeHandle,
    queries: Float32Array,
    k: number,
    nProbe: number,
  ): IdMapIndexSearchResult;
  idx_remove(handle: NativeHandle, id: bigint): boolean;
  idx_remove_logged(handle: NativeHandle, id: bigint, deltaPath: string): boolean;
  idx_compact(handle: NativeHandle): void;
  idx_contains(handle: NativeHandle, id: bigint): boolean;
  idx_prepare(handle: NativeHandle): void;
  idx_write(handle: NativeHandle, path: string): void;
  idx_compact_delta(handle: NativeHandle, snapshotPath: string, deltaPath: string): void;
  idx_dispose(handle: NativeHandle): void;
  idx_filter_dispose(handle: NativeHandle): void;
  idx_len(handle: NativeHandle): number;
  idx_dim(handle: NativeHandle): number;
  idx_bit_width(handle: NativeHandle): IdMapIndexBitWidth;
}

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

function isPositiveInt32(value: number) {
  return Number.isInteger(value) && value > 0 && value <= INT32_MAX;
}

function isNonNegativeInt32(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= INT32_MAX;
}

function requireNonEmptyPath(value: string, name: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function ensureHandle(index: IdMapIndex) {
  const handle = index[HANDLE];
  if (handle === null) {
    throw new Error("IdMapIndex has been disposed");
  }
  return handle;
}

function normalizeStorageOptions(options: IdMapIndexOptions) {
  const hasBitWidth = options.bitWidth !== undefined;
  const hasStorage = options.storage !== undefined;
  let bitWidth: IdMapIndexBitWidth = options.bitWidth ?? 8;
  let storage: IdMapIndexStorage | undefined = options.storage;

  if (hasStorage) {
    if (
      typeof storage !== "string" ||
      !Object.prototype.hasOwnProperty.call(BIT_WIDTH_BY_STORAGE, storage)
    ) {
      throw new TypeError(
        "IdMapIndex: storage must be 'f32', 'q8', 'q4', 'turbovec-q4', or 'turbovec-q2'",
      );
    }
    const expectedBitWidth = BIT_WIDTH_BY_STORAGE[storage];
    if (!hasBitWidth) {
      bitWidth = expectedBitWidth;
    } else if (bitWidth !== expectedBitWidth) {
      throw new TypeError("IdMapIndex: bitWidth does not match storage");
    }
  } else {
    storage = STORAGE_BY_BIT_WIDTH[bitWidth];
  }

  if (storage === undefined) {
    throw new TypeError("IdMapIndex: bitWidth must be 2, 4, 8, or 32");
  }

  return { bitWidth, storage };
}

export class IdMapIndexFilter {
  [FILTER_HANDLE]: NativeHandle | null = null;
  [FILTER_OWNER]: IdMapIndex | null = null;

  private constructor() {
    throw new TypeError("IdMapIndexFilter instances must be created by IdMapIndex.prepareFilter()");
  }

  search(queries: Float32Array, k: number) {
    if (!(queries instanceof Float32Array)) {
      throw new TypeError("IdMapIndexFilter.search: queries must be a Float32Array");
    }
    if (!isPositiveInt32(k)) {
      throw new TypeError("IdMapIndexFilter.search: k must be a positive int32");
    }
    const owner = this[FILTER_OWNER];
    const filterHandle = this[FILTER_HANDLE];
    if (owner === null || filterHandle === null) {
      throw new Error("IdMapIndexFilter has been disposed");
    }
    return binding.idx_search_prepared_filtered(ensureHandle(owner), filterHandle, queries, k);
  }

  dispose() {
    const filterHandle = this[FILTER_HANDLE];
    if (filterHandle === null) return;

    const owner = this[FILTER_OWNER];
    binding.idx_filter_dispose(filterHandle);
    this[FILTER_HANDLE] = null;
    this[FILTER_OWNER] = null;
    owner?.[FILTERS].delete(this);
  }
}

function createFilter(owner: IdMapIndex, handle: NativeHandle) {
  const filter = Object.create(IdMapIndexFilter.prototype) as IdMapIndexFilter;
  filter[FILTER_OWNER] = owner;
  filter[FILTER_HANDLE] = handle;
  return filter;
}

/**
 * CPU vector index with fixed dimensionality and stable uint64 external IDs.
 * Search uses dot products; callers requiring cosine similarity should
 * L2-normalize vectors before insertion and querying.
 */
export default class IdMapIndex {
  static Filter = IdMapIndexFilter;
  static IdMapIndex = IdMapIndex;
  static IdMapIndexFilter = IdMapIndexFilter;

  [HANDLE]: NativeHandle | null = null;
  [FILTERS] = new Set<IdMapIndexFilter>();

  constructor(options: IdMapIndexOptions) {
    const { dim } = options ?? ({} as IdMapIndexOptions);
    if (!isPositiveInt32(dim)) {
      throw new TypeError("IdMapIndex: dim must be a positive int32");
    }
    const { bitWidth, storage } = normalizeStorageOptions(options);
    if (storage.startsWith("turbovec-") && (dim > 65_536 || dim % 8 !== 0)) {
      throw new RangeError(
        "IdMapIndex: TurboVec dim must be divisible by 8 and no greater than 65536",
      );
    }
    this[HANDLE] = binding.idx_create({ dim, bitWidth, storage });
  }

  static load(path: string) {
    requireNonEmptyPath(path, "IdMapIndex.load: path");
    return IdMapIndex.fromHandle(binding.idx_load(path));
  }

  static loadMmap(path: string) {
    requireNonEmptyPath(path, "IdMapIndex.loadMmap: path");
    return IdMapIndex.fromHandle(binding.idx_load_mmap(path));
  }

  static loadWithDelta(snapshotPath: string, deltaPath: string) {
    requireNonEmptyPath(snapshotPath, "IdMapIndex.loadWithDelta: snapshotPath");
    requireNonEmptyPath(deltaPath, "IdMapIndex.loadWithDelta: deltaPath");
    return IdMapIndex.fromHandle(binding.idx_load_with_delta(snapshotPath, deltaPath));
  }

  private static fromHandle(handle: NativeHandle) {
    const instance = Object.create(IdMapIndex.prototype) as IdMapIndex;
    instance[HANDLE] = handle;
    instance[FILTERS] = new Set();
    return instance;
  }

  addWithIds(vectors: Float32Array, ids: BigUint64Array) {
    this.validateBatch("addWithIds", vectors, ids);
    if (ids.length === 0) return;
    binding.idx_add(ensureHandle(this), vectors, ids);
  }

  addLogged(vectors: Float32Array, ids: BigUint64Array, deltaPath: string) {
    this.validateBatch("addLogged", vectors, ids);
    requireNonEmptyPath(deltaPath, "addLogged: deltaPath");
    if (ids.length === 0) return;
    binding.idx_add_logged(ensureHandle(this), vectors, ids, deltaPath);
  }

  search(queries: Float32Array, k: number) {
    this.validateSearch("search", queries, k);
    return binding.idx_search(ensureHandle(this), queries, k);
  }

  searchFiltered(queries: Float32Array, k: number, allowedIds: BigUint64Array) {
    this.validateSearch("searchFiltered", queries, k);
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError("searchFiltered: allowedIds must be a BigUint64Array");
    }
    return binding.idx_search_filtered(ensureHandle(this), queries, k, allowedIds);
  }

  prepareFilter(allowedIds: BigUint64Array) {
    if (!(allowedIds instanceof BigUint64Array)) {
      throw new TypeError("prepareFilter: allowedIds must be a BigUint64Array");
    }
    const filter = createFilter(this, binding.idx_filter_create(ensureHandle(this), allowedIds));
    this[FILTERS].add(filter);
    return filter;
  }

  buildIvf(nLists: number, nIter = 0) {
    if (!isPositiveInt32(nLists)) {
      throw new TypeError("buildIvf: nLists must be a positive int32");
    }
    if (!isNonNegativeInt32(nIter)) {
      throw new TypeError("buildIvf: nIter must be a non-negative int32");
    }
    binding.idx_build_ivf(ensureHandle(this), nLists, nIter);
  }

  searchIvf(queries: Float32Array, k: number, nProbe: number) {
    this.validateSearch("searchIvf", queries, k);
    if (!isPositiveInt32(nProbe)) {
      throw new TypeError("searchIvf: nProbe must be a positive int32");
    }
    return binding.idx_search_ivf(ensureHandle(this), queries, k, nProbe);
  }

  remove(id: bigint) {
    this.validateId("remove", id);
    return binding.idx_remove(ensureHandle(this), id);
  }

  removeLogged(id: bigint, deltaPath: string) {
    this.validateId("removeLogged", id);
    requireNonEmptyPath(deltaPath, "removeLogged: deltaPath");
    return binding.idx_remove_logged(ensureHandle(this), id, deltaPath);
  }

  compact() {
    binding.idx_compact(ensureHandle(this));
  }

  contains(id: bigint) {
    this.validateId("contains", id);
    return binding.idx_contains(ensureHandle(this), id);
  }

  prepare() {
    binding.idx_prepare(ensureHandle(this));
  }

  write(path: string) {
    requireNonEmptyPath(path, "write: path");
    binding.idx_write(ensureHandle(this), path);
  }

  compactDelta(snapshotPath: string, deltaPath: string) {
    requireNonEmptyPath(snapshotPath, "compactDelta: snapshotPath");
    requireNonEmptyPath(deltaPath, "compactDelta: deltaPath");
    binding.idx_compact_delta(ensureHandle(this), snapshotPath, deltaPath);
  }

  get length() {
    return binding.idx_len(ensureHandle(this));
  }

  get dim() {
    return binding.idx_dim(ensureHandle(this));
  }

  get bitWidth() {
    return binding.idx_bit_width(ensureHandle(this));
  }

  dispose() {
    const handle = this[HANDLE];
    if (handle === null) return;

    for (const filter of this[FILTERS]) {
      filter.dispose();
    }
    this[FILTERS].clear();
    binding.idx_dispose(handle);
    this[HANDLE] = null;
  }

  private validateBatch(name: string, vectors: Float32Array, ids: BigUint64Array) {
    if (!(vectors instanceof Float32Array)) {
      throw new TypeError(`${name}: vectors must be a Float32Array`);
    }
    if (!(ids instanceof BigUint64Array)) {
      throw new TypeError(`${name}: ids must be a BigUint64Array`);
    }
    if (vectors.length !== ids.length * this.dim) {
      throw new RangeError(
        `${name}: vectors.length (${vectors.length}) must equal ids.length (${ids.length}) * dim (${this.dim})`,
      );
    }
  }

  private validateSearch(name: string, queries: Float32Array, k: number) {
    if (!(queries instanceof Float32Array)) {
      throw new TypeError(`${name}: queries must be a Float32Array`);
    }
    if (!isPositiveInt32(k)) {
      throw new TypeError(`${name}: k must be a positive int32`);
    }
  }

  private validateId(name: string, id: bigint) {
    if (typeof id !== "bigint") {
      throw new TypeError(`${name}: id must be a bigint`);
    }
  }
}

export { IdMapIndex };

module.exports = IdMapIndex;
