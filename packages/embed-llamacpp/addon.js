"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BertInterface = void 0;
exports.mapAddonEvent = mapAddonEvent;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const path = require("bare-path");
/**
 * Normalize a raw native event into `Output` / `Error` / `JobEnded`, mapping
 * `backendDevice` from `0/1` to `'cpu'/'gpu'`. Returns `null` for unknown
 * event names (caller logs and skips dispatch).
 */
function mapAddonEvent(rawEvent, rawData, rawError) {
    // RuntimeStats detected structurally (any of the known stats keys).
    const isStatsData = rawData !== null &&
        typeof rawData === "object" &&
        ("tokens_per_second" in rawData ||
            "total_tokens" in rawData ||
            "total_time_ms" in rawData ||
            "batch_size" in rawData ||
            "context_size" in rawData);
    if (isStatsData) {
        const stats = { ...rawData };
        if (stats.backendDevice === 0) {
            stats.backendDevice = "cpu";
        }
        else if (stats.backendDevice === 1) {
            stats.backendDevice = "gpu";
        }
        return { type: "JobEnded", data: stats, error: null };
    }
    if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
        return { type: "Error", data: rawData, error: rawError };
    }
    if (typeof rawEvent === "string" && rawEvent.includes("Embeddings")) {
        return { type: "Output", data: rawData, error: null };
    }
    return null;
}
/** An interface between the Bare C++ addon and the JS runtime. */
class BertInterface {
    _binding;
    _handle;
    constructor(binding, configurationParams, outputCb) {
        this._binding = binding;
        if (!configurationParams.backendsDir) {
            configurationParams.backendsDir = path.join(__dirname, "prebuilds");
        }
        this._handle = this._binding.createInstance(this, configurationParams, outputCb);
    }
    /** Cancel current inference process. Resolves when the job has stopped. */
    async cancel() {
        if (!this._handle)
            return;
        await this._binding.cancel(this._handle);
    }
    /**
     * Processes new input.
     *   - `type: 'text'` for a single string input
     *   - `type: 'sequences'` for a string-array input
     * Resolves `true` if the job was accepted, `false` if busy.
     */
    async runJob(data) {
        return this._binding.runJob(this._handle, data);
    }
    async loadWeights(data) {
        return this._binding.loadWeights(this._handle, data);
    }
    /** Activates the model to start processing the queue. */
    async activate() {
        return this._binding.activate(this._handle);
    }
    /** Stops the addon process and clears resources (including memory). */
    // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous destroyInstance throw surfaces as a rejected promise, matching the pre-migration contract
    async unload() {
        if (!this._handle)
            return;
        this._binding.destroyInstance(this._handle);
        this._handle = null;
    }
}
exports.BertInterface = BertInterface;
