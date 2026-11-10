"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GgmlModel = void 0;
exports.withRawRgb = withRawRgb;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS exports. */
const fs = require("bare-fs");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
const STAT_KEYS = ["total_time_ms", "backend_id", "cpu_fallback_nodes", "weight_bytes"];
/** Upper bound for the `threads` option. */
const MAX_THREADS = 1024;
/**
 * Lifecycle shared by MegaLoc and BridgeDepth: option checks, lazy native load,
 * one job at a time, runtime stats, unload and destroy. A subclass names the
 * model and implements its own inference call on top of `runJob()`.
 */
class GgmlModel {
    name;
    modelType;
    logger;
    addon = null;
    job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
    exclusive = (0, infer_base_1.exclusiveRunQueue)();
    destroyed = false;
    stats = {};
    options;
    /** `name` starts every error message; `modelType` selects the native model. */
    constructor(name, modelType, options) {
        this.name = name;
        this.modelType = modelType;
        if (!options || typeof options.modelPath !== "string" || !options.modelPath) {
            throw new TypeError(`${name} modelPath is required`);
        }
        if (options.threads !== undefined &&
            (!Number.isInteger(options.threads) || options.threads < 1 || options.threads > MAX_THREADS)) {
            throw new RangeError(`${name} threads must be an integer between 1 and ${MAX_THREADS}`);
        }
        this.options = { ...options };
        this.logger = new QvacLogger(options.logger);
    }
    getState() {
        return { configLoaded: this.addon !== null, destroyed: this.destroyed };
    }
    getRuntimeStats() {
        return { ...this.stats };
    }
    load() {
        return this.exclusive(async () => {
            if (this.destroyed)
                throw new Error(`${this.name} has been destroyed`);
            if (this.addon)
                return;
            if (!fs.existsSync(this.options.modelPath)) {
                throw new Error(`${this.name} GGUF weights not found at: ${this.options.modelPath}`);
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is loaded lazily.
            const binding = require("./binding");
            let addon = null;
            try {
                addon = new addon_1.ClassificationInterface(binding, { path: this.options.modelPath, modelType: this.modelType, config: {
                        backend: this.options.backend,
                        threads: this.options.threads,
                        backendsDir: this.options.backendsDir,
                    } }, (_owner, event, data, error) => this.onEvent(event, data, error), this.logger, { disableNativeLogger: true });
                await addon.activate();
                this.addon = addon;
            }
            catch (error) {
                await addon?.unload();
                throw error;
            }
        });
    }
    /**
     * Runs one job and returns `extract()` of what the addon emitted.
     * `jobName` names the job in the rejection message; `extract` returns null
     * for an output of the wrong shape, which rejects with `invalidMessage`.
     */
    runJob(input, jobName, extract, invalidMessage) {
        return this.exclusive(async () => {
            if (!this.addon)
                throw new Error(`${this.name} is not loaded. Call load() first.`);
            this.stats = {};
            const response = this.job.start();
            const pending = response.await();
            try {
                const accepted = await this.addon.runJob(input);
                if (!accepted)
                    throw new Error(`${jobName} was rejected`);
            }
            catch (error) {
                this.job.fail(error);
            }
            const result = extract(await pending);
            if (result === null)
                throw new Error(invalidMessage);
            return result;
        });
    }
    onEvent(event, data, error) {
        const mapped = (0, addon_1.mapAddonEvent)(event, data, error);
        if (!mapped)
            return;
        if (mapped.type === "Error") {
            this.job.fail(error instanceof Error ? error : new Error(String(error)));
        }
        else if (mapped.type === "Output") {
            this.job.output(mapped.data);
        }
        else if (mapped.type === "JobEnded") {
            if (data && typeof data === "object") {
                const values = data;
                this.stats = {};
                for (const key of STAT_KEYS) {
                    if (typeof values[key] === "number")
                        this.stats[key] = values[key];
                }
            }
            this.job.end();
        }
    }
    async release() {
        if (this.addon) {
            await this.addon.cancel();
            await this.addon.unload();
            this.addon = null;
        }
        this.stats = {};
    }
    unload() {
        return this.exclusive(() => this.release());
    }
    destroy() {
        return this.exclusive(async () => {
            await this.release();
            this.destroyed = true;
        });
    }
}
exports.GgmlModel = GgmlModel;
/** Copies the raw RGB dimensions onto a job; JPEG/PNG input passes none. */
function withRawRgb(input, options) {
    if (options) {
        if (options.width !== undefined)
            input.width = options.width;
        if (options.height !== undefined)
            input.height = options.height;
        if (options.channels !== undefined)
            input.channels = options.channels;
    }
    return input;
}
