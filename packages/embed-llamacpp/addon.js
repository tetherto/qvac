"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BertInterface = void 0;
exports.toBertJobInput = toBertJobInput;
exports.mapAddonEvent = mapAddonEvent;
exports.pickPrimaryGgufPath = pickPrimaryGgufPath;
function isMediaPart(part) {
    return (part !== null &&
        typeof part === "object" &&
        part.media instanceof Uint8Array);
}
/** Maps ordered parts to native parts, merging adjacent text. */
function toAddonParts(parts, where) {
    const result = [];
    for (const [i, part] of parts.entries()) {
        if (typeof part === "string") {
            const last = result[result.length - 1];
            if (last?.type === "text") {
                last.text += part;
            }
            else {
                result.push({ type: "text", text: part });
            }
        }
        else if (isMediaPart(part)) {
            result.push({ type: "media", data: part.media });
        }
        else {
            throw new TypeError(`${where}[${i}] must be a string or { media: Uint8Array }`);
        }
    }
    return result;
}
/**
 * Maps a `GGMLBert.run()` input to the native job. Inputs without media take
 * the text path (`text` / `sequences`), so they need no projection model.
 */
function toBertJobInput(input) {
    if (typeof input === "string") {
        return { type: "text", input };
    }
    if (Array.isArray(input)) {
        const unknownInput = input;
        const notString = unknownInput.findIndex((item) => typeof item !== "string");
        if (notString !== -1) {
            throw new TypeError(isMediaPart(unknownInput[notString])
                ? `input[${notString}]: media goes in { inputs: [...] }, where each input is a string or an array of parts; a bare array is one embedding per string`
                : `input[${notString}] must be a string`);
        }
        return { type: "sequences", input };
    }
    if (input !== null &&
        typeof input === "object" &&
        Array.isArray(input.inputs)) {
        const inputs = input.inputs.map((item, i) => {
            if (typeof item === "string") {
                return [{ type: "text", text: item }];
            }
            if (Array.isArray(item)) {
                return toAddonParts(item, `inputs[${i}]`);
            }
            throw new TypeError(`inputs[${i}] must be a string or an array of parts`);
        });
        if (inputs.every((parts) => parts.every((part) => part.type === "text"))) {
            return {
                type: "sequences",
                input: inputs.map((parts) => parts.map((part) => part.text).join("")),
            };
        }
        return { type: "multimodal", input: inputs };
    }
    throw new TypeError("input must be a string, an array or { inputs: [...] }");
}
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
/**
 * Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole
 * entry for single-file models. Matches the C++ shard-expansion contract
 * in `GGUFShards::expandGGUFIntoShards`.
 */
function pickPrimaryGgufPath(files) {
    const SHARD_REGEX = /-\d+-of-\d+\.gguf$/;
    return files.find((p) => SHARD_REGEX.test(p)) || files[0];
}
/** An interface between the Bare C++ addon and the JS runtime. */
class BertInterface {
    _binding;
    _handle;
    constructor(binding, configurationParams, outputCb) {
        this._binding = binding;
        // createInstance reads the keys unconditionally.
        configurationParams.backendsDir ??= "";
        configurationParams.projectionPath ??= "";
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
     *   - `type: 'multimodal'` for inputs of ordered text and media parts
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
