"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LayaDecisions = exports.LayaInterface = void 0;
exports.mapLayaEvent = mapLayaEvent;
const modelRunner_1 = require("./modelRunner");
/**
 * Normalize a raw native event of a Laya instance. The output is laya's
 * response JSON, parsed here; `backendDevice` in the stats maps `0/1` to
 * `'cpu'/'gpu'`. Returns `null` for unknown events.
 */
function mapLayaEvent(rawEvent, rawData, rawError) {
    if (typeof rawEvent === "string" && rawEvent.includes("LayaDecisionResult")) {
        return { type: "Output", data: JSON.parse(rawData), error: null };
    }
    if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
        return { type: "Error", data: rawData, error: rawError };
    }
    if (rawData !== null && typeof rawData === "object" && "forward_passes" in rawData) {
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
/** An interface between the native Laya instance and the JS runtime. */
class LayaInterface extends modelRunner_1.ModelInterface {
    _createInstance(configurationParams, outputCb) {
        return this._binding.createLayaInstance(this, configurationParams, outputCb);
    }
    /** Resolves `true` if the job was accepted, `false` if busy. */
    async runJob(requestJson) {
        return this._binding.runJob(this._handle, { type: "text", input: requestJson });
    }
}
exports.LayaInterface = LayaInterface;
/**
 * Typed decisions with Laya checkpoints: answers `choice`, `score` and `noul`
 * questions about a state in one forward pass per question.
 *
 * ```js
 * const laya = new LayaDecisions({ files: { model: [path] }, config: { device: 'gpu', gpu_layers: '99' } })
 * await laya.load()
 * const [result] = await (await laya.run({ state, questions })).await()
 * ```
 */
class LayaDecisions extends modelRunner_1.ModelRunner {
    _modelName = "Laya";
    async run(request) {
        return this._runRequest(request);
    }
    _createAddon(binding, configurationParams, outputCb) {
        return new LayaInterface(binding, configurationParams, outputCb);
    }
    _encodeRequest(request) {
        return JSON.stringify(request);
    }
    _startJob(addon, requestJson) {
        return addon.runJob(requestJson);
    }
    _mapEvent(event, data, error) {
        return mapLayaEvent(event, data, error);
    }
}
exports.LayaDecisions = LayaDecisions;
