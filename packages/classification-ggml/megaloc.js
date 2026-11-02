"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MegaLoc = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS exports. */
const fs = require("bare-fs");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
/** Produces an 8,448-element, L2-normalized visual place descriptor. */
class MegaLoc {
    options;
    logger;
    addon = null;
    job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
    exclusive = (0, infer_base_1.exclusiveRunQueue)();
    destroyed = false;
    stats = {};
    constructor(options) {
        this.options = options;
        if (!options || typeof options.modelPath !== "string" || !options.modelPath) {
            throw new TypeError("MegaLoc modelPath is required");
        }
        if (options.threads !== undefined &&
            (!Number.isInteger(options.threads) || options.threads < 1 || options.threads > 1024)) {
            throw new RangeError("MegaLoc threads must be an integer between 1 and 1024");
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
                throw new Error("MegaLoc has been destroyed");
            if (this.addon)
                return;
            if (!fs.existsSync(this.options.modelPath)) {
                throw new Error(`MegaLoc GGUF weights not found at: ${this.options.modelPath}`);
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is loaded lazily.
            const binding = require("./binding");
            let addon = null;
            try {
                addon = new addon_1.ClassificationInterface(binding, { path: this.options.modelPath, modelType: "megaloc", config: {
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
    embed(image, options) {
        return this.exclusive(async () => {
            if (!this.addon)
                throw new Error("MegaLoc is not loaded. Call load() first.");
            const input = { type: "embedding", content: image };
            if (options) {
                if (options.width !== undefined)
                    input.width = options.width;
                if (options.height !== undefined)
                    input.height = options.height;
                if (options.channels !== undefined)
                    input.channels = options.channels;
            }
            this.stats = {};
            const response = this.job.start();
            const pending = response.await();
            try {
                const accepted = await this.addon.runJob(input);
                if (!accepted)
                    throw new Error("MegaLoc embedding job was rejected");
            }
            catch (error) {
                this.job.fail(error);
            }
            const collected = await pending;
            const result = Array.isArray(collected) ? collected[0] : collected;
            if (!(result instanceof Float32Array) || result.length !== 8448) {
                throw new Error("MegaLoc returned an invalid descriptor");
            }
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
                for (const key of ["total_time_ms", "backend_id", "cpu_fallback_nodes", "weight_bytes"]) {
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
exports.MegaLoc = MegaLoc;
