"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelRunner = exports.ModelInterface = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
/**
 * An interface between one native model instance and the JS runtime. A
 * subclass creates the instance and adds its own `runJob`.
 */
class ModelInterface {
    _binding;
    _handle;
    constructor(binding, configurationParams, outputCb) {
        this._binding = binding;
        // The native create call reads the key unconditionally.
        configurationParams.backendsDir ??= "";
        this._handle = this._createInstance(configurationParams, outputCb);
    }
    async cancel() {
        if (!this._handle)
            return;
        await this._binding.cancel(this._handle);
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
exports.ModelInterface = ModelInterface;
const RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";
/**
 * The lifecycle a standalone model class shares: load (streaming shards),
 * one request at a time, cancel and unload, over its own native instance.
 * A subclass names the model and supplies how the instance is created, how a
 * request becomes the job's input, and how native events map to outputs.
 */
class ModelRunner {
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
    /** The package's native binding, resolved lazily from its prebuilds. */
    _loadBinding() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        return require("./binding");
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
        this.logger.info(`Creating ${this._modelName} instance with configuration:`, configurationParams);
        try {
            const binding = this._loadBinding();
            this._addon = this._createAddon(binding, configurationParams, this._outputCallback.bind(this));
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
        this.logger.info(`${this._modelName} model loaded`);
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
    /** Runs one request; a subclass's `run()` checks and forwards it here. */
    async _runRequest(request) {
        return this._run(() => this._runInternal(request));
    }
    async _runInternal(request) {
        if (!this._addon) {
            throw new Error("Addon not initialized. Call load() first.");
        }
        if (this._hasActiveResponse) {
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        const payload = this._encodeRequest(request);
        const response = this._job.start();
        let accepted;
        try {
            accepted = await this._startJob(this._addon, payload);
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
            this.logger?.warn?.(`${this._modelName} response rejected:`, err?.message ?? err);
        });
        response.await = () => finalized;
        return response;
    }
    _outputCallback(_addon, event, data, error) {
        let mapped;
        try {
            mapped = this._mapEvent(event, data, error);
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
exports.ModelRunner = ModelRunner;
