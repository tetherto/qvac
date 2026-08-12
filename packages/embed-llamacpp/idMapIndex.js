"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdMapIndex = exports.IdMapIndexFilter = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- The native Bare binding is resolved through CommonJS. */
const binding = require("./binding");
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
};
const STORAGE_BY_BIT_WIDTH = {
    2: "turbovec-q2",
    4: "q4",
    8: "q8",
    32: "f32",
};
function isPositiveInt32(value) {
    return Number.isInteger(value) && value > 0 && value <= INT32_MAX;
}
function isNonNegativeInt32(value) {
    return Number.isInteger(value) && value >= 0 && value <= INT32_MAX;
}
function requireNonEmptyPath(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}
function ensureHandle(index) {
    const handle = index[HANDLE];
    if (handle === null) {
        throw new Error("IdMapIndex has been disposed");
    }
    return handle;
}
function normalizeStorageOptions(options) {
    const hasBitWidth = options.bitWidth !== undefined;
    const hasStorage = options.storage !== undefined;
    let bitWidth = options.bitWidth ?? 8;
    let storage = options.storage;
    if (hasStorage) {
        if (typeof storage !== "string" ||
            !Object.prototype.hasOwnProperty.call(BIT_WIDTH_BY_STORAGE, storage)) {
            throw new TypeError("IdMapIndex: storage must be 'f32', 'q8', 'q4', 'turbovec-q4', or 'turbovec-q2'");
        }
        const expectedBitWidth = BIT_WIDTH_BY_STORAGE[storage];
        if (!hasBitWidth) {
            bitWidth = expectedBitWidth;
        }
        else if (bitWidth !== expectedBitWidth) {
            throw new TypeError("IdMapIndex: bitWidth does not match storage");
        }
    }
    else {
        storage = STORAGE_BY_BIT_WIDTH[bitWidth];
    }
    if (storage === undefined) {
        throw new TypeError("IdMapIndex: bitWidth must be 2, 4, 8, or 32");
    }
    return { bitWidth, storage };
}
class IdMapIndexFilter {
    [FILTER_HANDLE] = null;
    [FILTER_OWNER] = null;
    constructor() {
        throw new TypeError("IdMapIndexFilter instances must be created by IdMapIndex.prepareFilter()");
    }
    search(queries, k) {
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
        if (filterHandle === null)
            return;
        const owner = this[FILTER_OWNER];
        binding.idx_filter_dispose(filterHandle);
        this[FILTER_HANDLE] = null;
        this[FILTER_OWNER] = null;
        owner?.[FILTERS].delete(this);
    }
}
exports.IdMapIndexFilter = IdMapIndexFilter;
function createFilter(owner, handle) {
    const filter = Object.create(IdMapIndexFilter.prototype);
    filter[FILTER_OWNER] = owner;
    filter[FILTER_HANDLE] = handle;
    return filter;
}
/**
 * CPU vector index with fixed dimensionality and stable uint64 external IDs.
 * Search uses dot products; callers requiring cosine similarity should
 * L2-normalize vectors before insertion and querying.
 */
class IdMapIndex {
    static Filter = IdMapIndexFilter;
    static IdMapIndex = IdMapIndex;
    static IdMapIndexFilter = IdMapIndexFilter;
    [HANDLE] = null;
    [FILTERS] = new Set();
    constructor(options) {
        const { dim } = options ?? {};
        if (!isPositiveInt32(dim)) {
            throw new TypeError("IdMapIndex: dim must be a positive int32");
        }
        const { bitWidth, storage } = normalizeStorageOptions(options);
        if (storage.startsWith("turbovec-") && (dim > 65_536 || dim % 8 !== 0)) {
            throw new RangeError("IdMapIndex: TurboVec dim must be divisible by 8 and no greater than 65536");
        }
        this[HANDLE] = binding.idx_create({ dim, bitWidth, storage });
    }
    static load(path) {
        requireNonEmptyPath(path, "IdMapIndex.load: path");
        return IdMapIndex.fromHandle(binding.idx_load(path));
    }
    static loadMmap(path) {
        requireNonEmptyPath(path, "IdMapIndex.loadMmap: path");
        return IdMapIndex.fromHandle(binding.idx_load_mmap(path));
    }
    static loadWithDelta(snapshotPath, deltaPath) {
        requireNonEmptyPath(snapshotPath, "IdMapIndex.loadWithDelta: snapshotPath");
        requireNonEmptyPath(deltaPath, "IdMapIndex.loadWithDelta: deltaPath");
        return IdMapIndex.fromHandle(binding.idx_load_with_delta(snapshotPath, deltaPath));
    }
    static fromHandle(handle) {
        const instance = Object.create(IdMapIndex.prototype);
        instance[HANDLE] = handle;
        instance[FILTERS] = new Set();
        return instance;
    }
    addWithIds(vectors, ids) {
        this.validateBatch("addWithIds", vectors, ids);
        if (ids.length === 0)
            return;
        binding.idx_add(ensureHandle(this), vectors, ids);
    }
    addLogged(vectors, ids, deltaPath) {
        this.validateBatch("addLogged", vectors, ids);
        requireNonEmptyPath(deltaPath, "addLogged: deltaPath");
        if (ids.length === 0)
            return;
        binding.idx_add_logged(ensureHandle(this), vectors, ids, deltaPath);
    }
    search(queries, k) {
        this.validateSearch("search", queries, k);
        return binding.idx_search(ensureHandle(this), queries, k);
    }
    searchFiltered(queries, k, allowedIds) {
        this.validateSearch("searchFiltered", queries, k);
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError("searchFiltered: allowedIds must be a BigUint64Array");
        }
        return binding.idx_search_filtered(ensureHandle(this), queries, k, allowedIds);
    }
    prepareFilter(allowedIds) {
        if (!(allowedIds instanceof BigUint64Array)) {
            throw new TypeError("prepareFilter: allowedIds must be a BigUint64Array");
        }
        const filter = createFilter(this, binding.idx_filter_create(ensureHandle(this), allowedIds));
        this[FILTERS].add(filter);
        return filter;
    }
    buildIvf(nLists, nIter = 0) {
        if (!isPositiveInt32(nLists)) {
            throw new TypeError("buildIvf: nLists must be a positive int32");
        }
        if (!isNonNegativeInt32(nIter)) {
            throw new TypeError("buildIvf: nIter must be a non-negative int32");
        }
        binding.idx_build_ivf(ensureHandle(this), nLists, nIter);
    }
    searchIvf(queries, k, nProbe) {
        this.validateSearch("searchIvf", queries, k);
        if (!isPositiveInt32(nProbe)) {
            throw new TypeError("searchIvf: nProbe must be a positive int32");
        }
        return binding.idx_search_ivf(ensureHandle(this), queries, k, nProbe);
    }
    remove(id) {
        this.validateId("remove", id);
        return binding.idx_remove(ensureHandle(this), id);
    }
    removeLogged(id, deltaPath) {
        this.validateId("removeLogged", id);
        requireNonEmptyPath(deltaPath, "removeLogged: deltaPath");
        return binding.idx_remove_logged(ensureHandle(this), id, deltaPath);
    }
    compact() {
        binding.idx_compact(ensureHandle(this));
    }
    contains(id) {
        this.validateId("contains", id);
        return binding.idx_contains(ensureHandle(this), id);
    }
    prepare() {
        binding.idx_prepare(ensureHandle(this));
    }
    write(path) {
        requireNonEmptyPath(path, "write: path");
        binding.idx_write(ensureHandle(this), path);
    }
    compactDelta(snapshotPath, deltaPath) {
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
        if (handle === null)
            return;
        for (const filter of this[FILTERS]) {
            filter.dispose();
        }
        this[FILTERS].clear();
        binding.idx_dispose(handle);
        this[HANDLE] = null;
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
        if (typeof id !== "bigint") {
            throw new TypeError(`${name}: id must be a bigint`);
        }
    }
}
exports.default = IdMapIndex;
exports.IdMapIndex = IdMapIndex;
module.exports = IdMapIndex;
