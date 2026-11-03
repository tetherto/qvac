"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBackendOption = validateBackendOption;
exports.resolveFabricOptions = resolveFabricOptions;
exports.assignFabricOptions = assignFabricOptions;
const ENGINE_OPTION_KEYS = {
    moss: [
        "maxNewTokens", "textTemperature", "textTopP", "textTopK",
        "audioTemperature", "audioTopP", "audioTopK", "audioRepetitionPenalty",
    ],
    parler: ["coremlDecoder", "coremlComputeUnits", "coremlStrict"],
    supertonic: [
        "precision", "f16Attn", "f16Weights", "f16WeightsDenyList", "kvAttnType",
        "vulkanEnvOverrides", "voiceStyleTtl", "voiceStyleDp",
    ],
    cosyvoice3: ["forceSpeechTokens"],
};
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INTEGER_KEYS = new Set(["maxNewTokens", "textTopK", "audioTopK", "f16Attn", "f16Weights", "kvAttnType"]);
const BOOLEAN_KEYS = new Set(["coremlDecoder", "coremlStrict"]);
const WEBGPU_ENGINES = ["supertonic", "parler", "cosyvoice3", "audio8"];
function validInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}
function validateOptionValue(key, value) {
    if (BOOLEAN_KEYS.has(key)) {
        if (typeof value !== "boolean")
            throw new Error(`${key} must be a boolean`);
        return;
    }
    if (key === "coremlComputeUnits") {
        if (!["all", "cpu_and_ane", "cpu_and_gpu", "cpu_only"].includes(value)) {
            throw new Error("coremlComputeUnits must be all, cpu_and_ane, cpu_and_gpu or cpu_only");
        }
        return;
    }
    if (key === "precision") {
        if (!["auto", "f32", "f16", "q8_0"].includes(value))
            throw new Error("Invalid precision");
        return;
    }
    if (key === "vulkanEnvOverrides") {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            !Object.values(value).every((entry) => typeof entry === "string")) {
            throw new Error("vulkanEnvOverrides must be an object with string values");
        }
        return;
    }
    if (key === "f16WeightsDenyList") {
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
            throw new Error("f16WeightsDenyList must be an array of strings");
        }
        return;
    }
    if (key === "voiceStyleTtl" || key === "voiceStyleDp" || key === "forceSpeechTokens") {
        validateVector(key, value);
        return;
    }
    if (INTEGER_KEYS.has(key)) {
        if (!validInteger(value))
            throw new Error(`${key} must be a 32-bit integer`);
    }
    else if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${key} must be a finite number`);
    }
}
function validateVector(key, value) {
    if (!Array.isArray(value) && !(value instanceof Float32Array))
        throw new Error(`${key} must be an array`);
    const entries = Array.from(value);
    const valid = key === "forceSpeechTokens"
        ? entries.every(validInteger)
        : entries.every((entry) => typeof entry === "number" && Number.isFinite(entry));
    if (!valid)
        throw new Error(`${key} contains an invalid number`);
}
function validateBackendOption(engine, backend) {
    if (backend === undefined)
        return;
    if (typeof backend !== "string")
        throw new Error("backend must be a string");
    if (/^webgpu/i.test(backend) && !WEBGPU_ENGINES.includes(engine)) {
        throw new Error(`tts-ggml: WebGPU has no established support for ${engine}`);
    }
}
function copyValue(value) {
    if (Array.isArray(value) || value instanceof Float32Array)
        return Array.from(value);
    if (value !== null && typeof value === "object")
        return { ...value };
    return value;
}
function resolveFabricOptions(engine, options) {
    if (engine === "moss")
        validateMossCounts(options);
    const result = {};
    copyEngineOptions(engine, options, result);
    if (engine === "supertonic" && ((options.voiceStyleTtl === undefined) !== (options.voiceStyleDp === undefined))) {
        throw new Error("voiceStyleTtl and voiceStyleDp must be supplied together");
    }
    return result;
}
function validateMossCounts(options) {
    if (options.nCtx !== undefined && (!validInteger(options.nCtx) || options.nCtx < 1)) {
        throw new Error("nCtx must be a positive 32-bit integer for MOSS");
    }
    if (options.maxNewTokens !== undefined && (!validInteger(options.maxNewTokens) || options.maxNewTokens < 1)) {
        throw new Error("maxNewTokens must be a positive 32-bit integer");
    }
}
function copyEngineOptions(engine, options, result) {
    for (const [owner, keys] of Object.entries(ENGINE_OPTION_KEYS)) {
        for (const key of keys) {
            const value = options[key];
            if (value === undefined)
                continue;
            if (owner !== engine)
                throw new Error(`tts-ggml: ${key} is ${owner}-only`);
            validateOptionValue(key, value);
            result[key] = copyValue(value);
        }
    }
}
function assignFabricOptions(settings, parameters) {
    for (const keys of Object.values(ENGINE_OPTION_KEYS)) {
        for (const key of keys) {
            const value = settings[key];
            if (value !== undefined)
                parameters[key] = copyValue(value);
        }
    }
}
