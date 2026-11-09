"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecisionEngine = exports.DecisionEngineInterface = exports.DECISION_INVALID_REQUEST = void 0;
exports.mapDecisionEngineEvent = mapDecisionEngineEvent;
const modelRunner_1 = require("./modelRunner");
/**
 * `code` of a run error for a request the model rejected (bad JSON, nesting
 * too deep, a limit or control the model does not support). Other run errors
 * are execution failures; a cancelled run fails with "Job cancelled".
 */
exports.DECISION_INVALID_REQUEST = "DECISION_INVALID_REQUEST";
const INVALID_REQUEST_MARKER = /^(?:\w+: )?invalid request: /;
// The native error is not always an `Error` instance of this realm, so it is
// matched by shape: a string, or an object with a string `message`.
function decisionRunError(rawError) {
    const message = typeof rawError === "string"
        ? rawError
        : rawError !== null &&
            typeof rawError === "object" &&
            typeof rawError.message === "string"
            ? rawError.message
            : null;
    if (message === null || !INVALID_REQUEST_MARKER.test(message)) {
        return rawError;
    }
    const error = new Error(message.replace(INVALID_REQUEST_MARKER, ""));
    error.code = exports.DECISION_INVALID_REQUEST;
    return error;
}
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
        return { type: "Error", data: rawData, error: decisionRunError(rawError) };
    }
    if (rawData !== null && typeof rawData === "object" && "decision_input_tokens" in rawData) {
        return { type: "JobEnded", data: { ...rawData }, error: null };
    }
    return null;
}
/** An interface between the native DecisionEngine instance and the JS runtime. */
class DecisionEngineInterface extends modelRunner_1.ModelInterface {
    _createInstance(configurationParams, outputCb) {
        return this._binding.createInstance(this, configurationParams, outputCb);
    }
    /**
     * Resolves `true` if the job was accepted, `false` if busy: a request is
     * rejected, not queued, while another runs.
     */
    async runJob(requestJson) {
        const admitted = await this._binding.runJob(this._handle, {
            type: "text",
            input: requestJson,
        });
        return typeof admitted === "number" ? admitted > 0 : admitted === true;
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
 * Upstream llama.cpp decision models (laya, openjev, lev, kev, clef, ...)
 * through upstream's server-context, run in-process by this addon. Requests
 * and results use upstream's /v1/systemone shapes, one state per run.
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
