"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecisionEngine = exports.DecisionEngineInterface = void 0;
exports.mapDecisionEngineEvent = mapDecisionEngineEvent;
const modelRunner_1 = require("./modelRunner");
/**
 * Normalize a raw native event of a DecisionEngine instance. The output is
 * upstream's response JSON, parsed here. Returns `null` for unknown events.
 */
function mapDecisionEngineEvent(rawEvent, rawData, rawError) {
    if (typeof rawEvent === "string" && rawEvent.includes("DecisionEngineResult")) {
        return {
            type: "Output",
            data: JSON.parse(rawData),
            error: null,
        };
    }
    if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
        return { type: "Error", data: rawData, error: rawError };
    }
    if (rawData !== null && typeof rawData === "object" && "decision_input_tokens" in rawData) {
        return { type: "JobEnded", data: { ...rawData }, error: null };
    }
    return null;
}
/** An interface between the native DecisionEngine instance and the JS runtime. */
class DecisionEngineInterface extends modelRunner_1.ModelInterface {
    _createInstance(configurationParams, outputCb) {
        return this._binding.createDecisionEngineInstance(this, configurationParams, outputCb);
    }
    /** Resolves `true` if the job was accepted, `false` if busy. */
    async runJob(requestJson) {
        return this._binding.runJob(this._handle, { type: "text", input: requestJson });
    }
    /** The loaded model's capabilities; call after activate(). */
    info() {
        if (!this._handle) {
            throw new Error("DecisionEngine is not loaded");
        }
        return JSON.parse(this._binding.decisionInfo(this._handle));
    }
}
exports.DecisionEngineInterface = DecisionEngineInterface;
/**
 * Upstream llama.cpp decision models (openjev, lev, kev, clef, upstream-format
 * laya, ...) through @qvac/fabric's decision bridge. Requests and results use
 * upstream's /v1/systemone shapes, one state per run. Fabric-format Laya
 * checkpoints use {@link LayaDecisions} instead.
 *
 * ```js
 * const engine = new DecisionEngine({ files: { model: [path] }, config: { device: 'gpu' } })
 * await engine.load()
 * engine.info() // { decision_type: 'openjev', noul: 'probability', ... }
 * const [result] = await (await engine.run({ state, questions })).await()
 * ```
 */
class DecisionEngine extends modelRunner_1.ModelRunner {
    _modelName = "DecisionEngine";
    /** Answers one state. `await()` on the response resolves to `[result]`. */
    async run(request) {
        return this._runRequest(request);
    }
    /** The loaded model's decision capabilities. Throws before load(). */
    info() {
        if (!this._addon) {
            throw new Error("Addon not initialized. Call load() first.");
        }
        return this._addon.info();
    }
    _createAddon(binding, configurationParams, outputCb) {
        return new DecisionEngineInterface(binding, configurationParams, outputCb);
    }
    _encodeRequest(request) {
        return JSON.stringify(request);
    }
    _startJob(addon, requestJson) {
        return addon.runJob(requestJson);
    }
    _mapEvent(event, data, error) {
        return mapDecisionEngineEvent(event, data, error);
    }
}
exports.DecisionEngine = DecisionEngine;
