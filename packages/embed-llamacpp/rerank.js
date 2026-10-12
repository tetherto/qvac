"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Reranker = exports.RerankInterface = void 0;
exports.mapRerankEvent = mapRerankEvent;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
/**
 * Normalize a raw native event of a rerank instance. The scores arrive as a
 * Float32Array and are returned as numbers; `backendDevice` in the stats maps
 * `0/1` to `'cpu'/'gpu'`. Returns `null` for unknown events.
 */
function mapRerankEvent(rawEvent, rawData, rawError) {
    if (typeof rawEvent === "string" && rawEvent.includes("RerankScores")) {
        return { type: "Output", data: Array.from(rawData), error: null };
    }
    if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
        return { type: "Error", data: rawData, error: rawError };
    }
    if (rawData !== null && typeof rawData === "object" && "documents" in rawData) {
        const stats = { ...rawData };
        if (stats.backendDevice === 0) {
            stats.backendDevice = "cpu";
        }
        else if (stats.backendDevice === 1) {
            stats.backendDevice = "gpu";
        }
        return { type: "JobEnded", data: stats, error: null };
    }
    return null;
}
/** An interface between the native rerank instance and the JS runtime. */
class RerankInterface {
    _binding;
    _handle;
    constructor(binding, configurationParams, outputCb) {
        this._binding = binding;
        // createRerankInstance reads the key unconditionally.
        configurationParams.backendsDir ??= "";
        this._handle = this._binding.createRerankInstance(this, configurationParams, outputCb);
    }
    async cancel() {
        if (!this._handle)
            return;
        await this._binding.cancel(this._handle);
    }
    /** Resolves `true` if the job was accepted, `false` if busy. */
    async runJob(query, documents) {
        return this._binding.runJob(this._handle, { type: "sequences", input: [query, ...documents] });
    }
    async loadWeights(data) {
        return this._binding.loadWeights(this._handle, data);
    }
    async activate() {
        return this._binding.activate(this._handle);
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous destroyInstance throw surfaces as a rejected promise
    async unload() {
        if (!this._handle)
            return;
        this._binding.destroyInstance(this._handle);
        this._handle = null;
    }
}
exports.RerankInterface = RerankInterface;
const RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";
function checkRequest(request) {
    if (request === null || typeof request !== "object") {
        throw new TypeError("request must be an object with query and documents");
    }
    if (typeof request.query !== "string") {
        throw new TypeError("request.query must be a string");
    }
    if (!Array.isArray(request.documents)) {
        throw new TypeError("request.documents must be an array of strings");
    }
    for (const [i, document] of request.documents.entries()) {
        if (typeof document !== "string") {
            throw new TypeError(`request.documents[${i}] must be a string`);
        }
    }
}
/**
 * Scores documents by relevance to a query with a reranker (cross-encoder)
 * GGUF, such as bge-reranker, jina-reranker or Qwen3-Reranker.
 *
 * ```js
 * const reranker = new Reranker({ files: { model: [path] }, config: { device: 'gpu', gpu_layers: '99' } })
 * await reranker.load()
 * const [scores] = await (await reranker.run({ query, documents })).await()
 * ```
 */
class Reranker {
    logger;
    opts;
    state;
    _addon;
    _files;
    _config;
    _job;
    _run;
    _hasActiveResponse;
    constructor({ files, config = {}, logger = null, opts = {} }) {
        if (!files || !Array.isArray(files.model) || files.model.length === 0) {
            throw new TypeError("files.model must be a non-empty array of absolute paths");
        }
        for (const [i, entry] of files.model.entries()) {
            if (typeof entry !== "string" || entry.length === 0) {
                throw new TypeError(`files.model[${i}] must be an absolute path string`);
            }
            if (!path.isAbsolute(entry)) {
                throw new TypeError(`files.model[${i}] must be an absolute path (got: ${entry})`);
            }
        }
        this._files = files.model;
        this._config = config;
        this.logger = new QvacLogger(logger);
        this.opts = opts;
        this._job = (0, infer_base_1.createJobHandler)({ cancel: () => this._addon?.cancel() });
        this._run = (0, infer_base_1.exclusiveRunQueue)();
        this._addon = null;
        this._hasActiveResponse = false;
        this.state = { configLoaded: false };
    }
    async load() {
        return this._run(async () => {
            if (this.state.configLoaded)
                return;
            await this._load();
            this.state.configLoaded = true;
        });
    }
    async _load() {
        const configurationParams = { path: (0, addon_1.pickPrimaryGgufPath)(this._files), config: this._config };
        this.logger.info("Creating rerank instance with configuration:", configurationParams);
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
            const binding = require("./binding");
            this._addon = new RerankInterface(binding, configurationParams, this._outputCallback.bind(this));
            if (this._files.length > 1) {
                await this._streamShards();
            }
            await this._addon.activate();
        }
        catch (loadError) {
            try {
                await this._addon?.unload();
            }
            catch { }
            this._addon = null;
            throw loadError;
        }
        this.logger.info("Rerank model loaded");
    }
    async _streamShards() {
        for (const filePath of this._files) {
            const filename = path.basename(filePath);
            for await (const chunk of fs.createReadStream(filePath)) {
                await this._addon.loadWeights({ filename, chunk, completed: false });
            }
            await this._addon.loadWeights({ filename, chunk: null, completed: true });
        }
    }
    /**
     * Scores each document against the query. `await()` on the response
     * resolves to `[scores]`, one score per document in the given order.
     */
    async run(request) {
        checkRequest(request);
        return this._run(() => this._runInternal(request));
    }
    async _runInternal(request) {
        if (!this._addon) {
            throw new Error("Addon not initialized. Call load() first.");
        }
        if (this._hasActiveResponse) {
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        const response = this._job.start();
        let accepted;
        try {
            accepted = await this._addon.runJob(request.query, request.documents);
        }
        catch (error) {
            this._job.fail(error);
            throw error;
        }
        if (!accepted) {
            this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE));
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        this._hasActiveResponse = true;
        const finalized = response.await().finally(() => {
            this._hasActiveResponse = false;
        });
        finalized.catch((err) => {
            this.logger?.warn?.("Rerank response rejected:", err?.message ?? err);
        });
        response.await = () => finalized;
        return response;
    }
    _outputCallback(_addon, event, data, error) {
        let mapped;
        try {
            mapped = mapRerankEvent(event, data, error);
        }
        catch (mapError) {
            this._job.fail(mapError);
            return;
        }
        if (mapped === null) {
            this.logger.warn(`Unhandled addon event: ${String(event)} (data type: ${typeof data})`);
            return;
        }
        if (mapped.type === "Error") {
            this.logger.error("Job failed with error:", mapped.error);
            this._job.fail(mapped.error);
            return;
        }
        if (mapped.type === "JobEnded") {
            this._job.end(this.opts.stats ? mapped.data : null);
            return;
        }
        this._job.output(mapped.data);
    }
    /** Unload the model and clear resources. Fails any in-flight job. */
    async unload() {
        return this._run(async () => {
            await this.cancel();
            if (this._job.active) {
                this._job.fail(new Error("Model was unloaded"));
            }
            this._hasActiveResponse = false;
            if (this._addon) {
                await this._addon.unload();
                this._addon = null;
            }
            this.state.configLoaded = false;
        });
    }
    /** Cancel the current request. */
    async cancel() {
        await this._addon?.cancel();
    }
    getState() {
        return this.state;
    }
}
exports.Reranker = Reranker;
