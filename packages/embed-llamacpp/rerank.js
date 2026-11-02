"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Reranker = exports.RerankInterface = void 0;
exports.mapRerankEvent = mapRerankEvent;
const modelRunner_1 = require("./modelRunner");
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
class RerankInterface extends modelRunner_1.ModelInterface {
    _createInstance(configurationParams, outputCb) {
        return this._binding.createRerankInstance(this, configurationParams, outputCb);
    }
    /** Resolves `true` if the job was accepted, `false` if busy. */
    async runJob(query, documents) {
        return this._binding.runJob(this._handle, { type: "sequences", input: [query, ...documents] });
    }
}
exports.RerankInterface = RerankInterface;
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
class Reranker extends modelRunner_1.ModelRunner {
    _modelName = "Rerank";
    /**
     * Scores each document against the query. `await()` on the response
     * resolves to `[scores]`, one score per document in the given order.
     */
    async run(request) {
        checkRequest(request);
        return this._runRequest(request);
    }
    _createAddon(binding, configurationParams, outputCb) {
        return new RerankInterface(binding, configurationParams, outputCb);
    }
    _encodeRequest(request) {
        return request;
    }
    _startJob(addon, request) {
        return addon.runJob(request.query, request.documents);
    }
    _mapEvent(event, data, error) {
        return mapRerankEvent(event, data, error);
    }
}
exports.Reranker = Reranker;
