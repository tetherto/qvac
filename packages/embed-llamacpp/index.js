"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GGMLBert = exports.assessFit = exports.mapRerankEvent = exports.RerankInterface = exports.Reranker = exports.mapLayaEvent = exports.LayaInterface = exports.LayaDecisions = exports.pickPrimaryGgufPath = exports.BertInterface = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
const fit_1 = require("./fit");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
const laya_1 = require("./laya");
const rerank_1 = require("./rerank");
var addon_2 = require("./addon");
Object.defineProperty(exports, "BertInterface", { enumerable: true, get: function () { return addon_2.BertInterface; } });
Object.defineProperty(exports, "pickPrimaryGgufPath", { enumerable: true, get: function () { return addon_2.pickPrimaryGgufPath; } });
var laya_2 = require("./laya");
Object.defineProperty(exports, "LayaDecisions", { enumerable: true, get: function () { return laya_2.LayaDecisions; } });
Object.defineProperty(exports, "LayaInterface", { enumerable: true, get: function () { return laya_2.LayaInterface; } });
Object.defineProperty(exports, "mapLayaEvent", { enumerable: true, get: function () { return laya_2.mapLayaEvent; } });
var rerank_2 = require("./rerank");
Object.defineProperty(exports, "Reranker", { enumerable: true, get: function () { return rerank_2.Reranker; } });
Object.defineProperty(exports, "RerankInterface", { enumerable: true, get: function () { return rerank_2.RerankInterface; } });
Object.defineProperty(exports, "mapRerankEvent", { enumerable: true, get: function () { return rerank_2.mapRerankEvent; } });
var fit_2 = require("./fit");
Object.defineProperty(exports, "assessFit", { enumerable: true, get: function () { return fit_2.assessFit; } });
const RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";
/** BERT client wrapping the native BertInterface for embedding generation. */
class GGMLBert {
    addon;
    logger;
    opts;
    state;
    _files;
    _projectionModelPath;
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
        if (files.projectionModel !== undefined) {
            if (typeof files.projectionModel !== "string" || files.projectionModel.length === 0) {
                throw new TypeError("files.projectionModel must be an absolute path string");
            }
            if (!path.isAbsolute(files.projectionModel)) {
                throw new TypeError(`files.projectionModel must be an absolute path (got: ${files.projectionModel})`);
            }
        }
        this._files = files.model;
        this._projectionModelPath = files.projectionModel ?? "";
        this._config = config;
        this.logger = new QvacLogger(logger);
        this.opts = opts;
        // Lazy deref + optional chain: safe before `_load()` and after `unload()`.
        this._job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
        this._run = (0, infer_base_1.exclusiveRunQueue)();
        this.addon = null;
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
        this.logger.info("Starting model load");
        const primaryGgufPath = (0, addon_1.pickPrimaryGgufPath)(this._files);
        const configurationParams = {
            path: primaryGgufPath,
            config: this._config,
            projectionPath: this._projectionModelPath,
        };
        this.logger.info("Creating addon with configuration:", configurationParams);
        try {
            this.addon = this._createAddon(configurationParams);
            if (this._files.length > 1) {
                await this._streamShards();
            }
            this.logger.info("Activating addon");
            await this.addon.activate();
        }
        catch (loadError) {
            // Best-effort cleanup of the partially-initialized addon so a subsequent
            // load() does not leak a zombie native instance.
            try {
                await this.addon?.unload?.();
            }
            catch { }
            this.addon = null;
            throw loadError;
        }
        this.logger.info("Model load completed successfully");
    }
    async _streamShards() {
        for (const filePath of this._files) {
            const filename = path.basename(filePath);
            const stream = fs.createReadStream(filePath);
            for await (const chunk of stream) {
                await this.addon.loadWeights({ filename, chunk, completed: false });
            }
            await this.addon.loadWeights({ filename, chunk: null, completed: true });
            this.logger.info(`Streamed weights for ${filename}`);
        }
    }
    /**
     * Embed text, or text mixed with images and audio when the model was given
     * `files.projectionModel`. See {@link EmbedRunInput} for the input shapes.
     */
    async run(input) {
        return this._run(() => this._runInternal(input));
    }
    async _runInternal(input) {
        if (!this.addon) {
            throw new Error("Addon not initialized. Call load() first.");
        }
        if (this._hasActiveResponse) {
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        const inputData = (0, addon_1.toBertJobInput)(input);
        if (inputData.type === "multimodal") {
            if (!this._projectionModelPath) {
                throw new TypeError("media input needs files.projectionModel");
            }
            this.logger.info(`Starting inference embeddings for ${inputData.input?.length ?? 0} multimodal input(s)`);
        }
        else {
            this.logger.info("Starting inference embeddings for text:", input);
        }
        const response = this._job.start();
        // addon-cpp guarantees no output events until runJob is fully accepted.
        // If runJob throws or returns false, no events will fire for this job.
        let accepted;
        try {
            accepted = await this.addon.runJob(inputData);
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
            const detail = (err &&
                typeof err === "object" &&
                "message" in err &&
                err.message) ||
                err;
            this.logger?.warn?.("Inference response rejected:", detail);
        });
        response.await = () => finalized;
        return response;
    }
    _addonOutputCallback(_addon, event, data, error) {
        const mapped = (0, addon_1.mapAddonEvent)(event, data, error);
        if (mapped === null) {
            // Reaching here means the native layer added an event shape the JS
            // wrapper does not know about. Warn and skip.
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
        if (mapped.type === "Output") {
            this._job.output(mapped.data);
        }
    }
    _createAddon(configurationParams) {
        this.logger.info("Creating Bert interface with configuration:", configurationParams);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        return new addon_1.BertInterface(binding, configurationParams, this._addonOutputCallback.bind(this));
    }
    /**
     * Unload the model and clear resources. Ensures any in-flight job is resolved as failed.
     */
    async unload() {
        return this._run(async () => {
            await this.cancel();
            if (this._job.active) {
                this._job.fail(new Error("Model was unloaded"));
            }
            this._hasActiveResponse = false;
            if (this.addon) {
                await this.addon.unload();
                // Null the addon reference so post-unload `cancel()` / `run()` calls hit the
                // `if (!this.addon)` guard instead of dereferencing a disposed native handle.
                this.addon = null;
            }
            this.state.configLoaded = false;
        });
    }
    /** Cancel the current task. */
    async cancel() {
        if (this.addon?.cancel) {
            await this.addon.cancel();
        }
    }
    getState() {
        return this.state;
    }
}
exports.GGMLBert = GGMLBert;
exports.default = GGMLBert;
const cjsExports = GGMLBert;
cjsExports.default = GGMLBert;
cjsExports.pickPrimaryGgufPath = addon_1.pickPrimaryGgufPath;
cjsExports.GGMLBert = GGMLBert;
cjsExports.BertInterface = addon_1.BertInterface;
cjsExports.LayaDecisions = laya_1.LayaDecisions;
cjsExports.LayaInterface = laya_1.LayaInterface;
cjsExports.mapLayaEvent = laya_1.mapLayaEvent;
cjsExports.Reranker = rerank_1.Reranker;
cjsExports.RerankInterface = rerank_1.RerankInterface;
cjsExports.mapRerankEvent = rerank_1.mapRerankEvent;
cjsExports.assessFit = fit_1.assessFit;
module.exports = cjsExports;
