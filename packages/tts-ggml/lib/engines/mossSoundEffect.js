"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOSS_SFX_CALL_KEYS = exports.MOSS_SFX_MAX_SHIFT = exports.MOSS_SFX_MAX_GUIDANCE = exports.MOSS_SFX_MAX_STEPS = exports.MOSS_SFX_MAX_SECONDS = exports.MOSS_SFX_NATIVE_SAMPLE_RATE = exports.MOSS_SFX_RE = void 0;
exports.assertSoundEffectFields = assertSoundEffectFields;
exports.pickSoundEffectFields = pickSoundEffectFields;
exports.resolveMossSoundEffectModelPaths = resolveMossSoundEffectModelPaths;
exports.assertMossSoundEffectOptions = assertMossSoundEffectOptions;
exports.resolveSoundEffectJobFields = resolveSoundEffectJobFields;
exports.buildMossSoundEffectParams = buildMossSoundEffectParams;
const engineIds_1 = require("../engineIds");
const modelFiles_1 = require("../modelFiles");
const nativeParams_1 = require("../nativeParams");
exports.MOSS_SFX_RE = /^moss-sfx(-[a-z0-9_]+)*\.gguf$/i;
exports.MOSS_SFX_NATIVE_SAMPLE_RATE = 48000;
exports.MOSS_SFX_MAX_SECONDS = 30;
exports.MOSS_SFX_MAX_STEPS = 1000;
exports.MOSS_SFX_MAX_GUIDANCE = 50;
exports.MOSS_SFX_MAX_SHIFT = 100;
exports.MOSS_SFX_CALL_KEYS = [
    "seconds",
    "negativePrompt",
    "steps",
    "guidance",
    "shift",
];
function assertSoundEffectRange(name, value, accepts, range) {
    if (typeof value === "number" && Number.isFinite(value) && accepts(value))
        return;
    throw new Error(`tts-ggml: moss-sfx ${name} must be ${range} (got ${String(value)})`);
}
function assertSoundEffectFields(fields) {
    if (fields.seconds !== undefined) {
        assertSoundEffectRange("seconds", fields.seconds, (n) => n > 0 && n <= exports.MOSS_SFX_MAX_SECONDS, `in (0, ${exports.MOSS_SFX_MAX_SECONDS}]`);
    }
    if (fields.steps !== undefined) {
        assertSoundEffectRange("steps", fields.steps, (n) => Number.isInteger(n) && n >= 1 && n <= exports.MOSS_SFX_MAX_STEPS, `an integer in [1, ${exports.MOSS_SFX_MAX_STEPS}]`);
    }
    if (fields.guidance !== undefined) {
        assertSoundEffectRange("guidance", fields.guidance, (n) => n >= 1 && n <= exports.MOSS_SFX_MAX_GUIDANCE, `in [1, ${exports.MOSS_SFX_MAX_GUIDANCE}]`);
    }
    if (fields.shift !== undefined) {
        assertSoundEffectRange("shift", fields.shift, (n) => n > 0 && n <= exports.MOSS_SFX_MAX_SHIFT, `in (0, ${exports.MOSS_SFX_MAX_SHIFT}]`);
    }
    if (fields.negativePrompt !== undefined && typeof fields.negativePrompt !== "string") {
        throw new Error("tts-ggml: moss-sfx negativePrompt must be a string");
    }
}
/**
 * Collect the MOSS-SoundEffect generation controls present on `source`.
 * Returns undefined when none are set.
 */
function pickSoundEffectFields(source) {
    if (source == null || typeof source !== "object")
        return undefined;
    const present = exports.MOSS_SFX_CALL_KEYS.filter((key) => source[key] !== undefined);
    if (present.length === 0)
        return undefined;
    return Object.fromEntries(present.map((key) => [key, source[key]]));
}
function resolveMossSoundEffectModelPaths(files) {
    return {
        mossSoundEffectPath: (0, modelFiles_1.firstNonEmpty)(files.mossSoundEffect, (0, modelFiles_1.findQuantRankedGguf)(files.modelDir, exports.MOSS_SFX_RE)),
    };
}
function assertMossSoundEffectOptions(setup) {
    if (setup.engineType !== engineIds_1.ENGINE_MOSS_SFX)
        return;
    if (setup.backend.enhancerGgufPath || setup.backend.denoiserGgufPath) {
        throw new Error("tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
            "the moss-sfx engine. Drop lavasrEnhancer / lavasrDenoiser.");
    }
    if (setup.settings.referenceAudio) {
        throw new Error("tts-ggml: referenceAudio is not supported by the moss-sfx engine, " +
            "which generates sound effects from a text prompt");
    }
    if (setup.settings.steps != null) {
        throw new Error("tts-ggml: the moss-sfx engine takes steps per call " +
            "(run({ input, steps })), not in the constructor");
    }
    assertMossSoundEffectOutputRate(setup);
    if (!setup.paths.mossSoundEffectPath) {
        throw new Error("tts-ggml: the moss-sfx engine needs its GGUF: stage " +
            "moss-sfx-*.gguf in modelDir or set files.mossSoundEffect");
    }
}
function assertMossSoundEffectOutputRate(setup) {
    if (setup.outputSampleRate == null ||
        setup.outputSampleRate === exports.MOSS_SFX_NATIVE_SAMPLE_RATE) {
        return;
    }
    throw new Error(`tts-ggml: the moss-sfx engine outputs ${exports.MOSS_SFX_NATIVE_SAMPLE_RATE} Hz ` +
        `audio and cannot resample (outputSampleRate=${setup.outputSampleRate})`);
}
/**
 * Extract + validate the per-call MOSS-SoundEffect controls from a run
 * input. Returns undefined when none are present.
 */
function resolveSoundEffectJobFields(setup, source, where) {
    const fields = pickSoundEffectFields(source);
    if (!fields)
        return undefined;
    if (setup.engineType !== engineIds_1.ENGINE_MOSS_SFX) {
        throw new Error(`tts-ggml: ${where}: ${Object.keys(fields).join(", ")} are ` +
            `moss-sfx-only options (engine is ${setup.engineType})`);
    }
    assertSoundEffectFields(fields);
    return fields;
}
function buildMossSoundEffectParams(setup) {
    assertMossSoundEffectOutputRate(setup);
    const parameters = {
        engineType: engineIds_1.ENGINE_MOSS_SFX,
        mossSoundEffectPath: setup.paths.mossSoundEffectPath || "",
    };
    (0, nativeParams_1.assignBackendParams)(setup, parameters);
    return parameters;
}
