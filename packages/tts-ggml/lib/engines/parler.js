"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PARLER_ONLY_KEYS = exports.PARLER_FIELD_KEYS = exports.PARLER_ONLY_TEMPLATE_KEYS = exports.PARLER_TEMPLATE_KEYS = exports.PARLER_DESCRIPTION_KEYS = exports.PARLER_QUANT_ORDER = exports.PARLER_VARIANT_ORDER = exports.PARLER_RE = void 0;
exports.findParlerInDir = findParlerInDir;
exports.pickParlerDescFields = pickParlerDescFields;
exports.assertParlerDescFieldsConsistent = assertParlerDescFieldsConsistent;
exports.resolveParlerModelPaths = resolveParlerModelPaths;
exports.assertParlerOptions = assertParlerOptions;
exports.resolveParlerJobFields = resolveParlerJobFields;
exports.buildParlerParams = buildParlerParams;
exports.applyParlerReload = applyParlerReload;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const conditioning_1 = require("../conditioning");
const engineIds_1 = require("../engineIds");
const modelFiles_1 = require("../modelFiles");
const nativeParams_1 = require("../nativeParams");
const options_1 = require("../options");
// Parler GGUFs ship per quant tier with the quant in the filename
// (`parler-mini-v1-q8_0.gguf`); a bare `parler.gguf` deliberately does not
// match, keeping ambiguous files out of the modelDir auto-detect path.
exports.PARLER_RE = /^parler-(mini|large|indic)(-v\d+)?(-[a-z0-9_]+)?\.gguf$/i;
exports.PARLER_VARIANT_ORDER = ["mini", "large", "indic"];
exports.PARLER_QUANT_ORDER = ["q8_0", "q6_k", "f16", "f32"];
exports.PARLER_DESCRIPTION_KEYS = ["description", "voiceDescription"];
// What native Parler reads as template fields. `emotion` / `pace` stay listed
// here because build_description() still renders them, even though they are
// cross-engine options at the JS surface.
exports.PARLER_TEMPLATE_KEYS = [
    "voice",
    "emotion",
    "pitch",
    "pace",
    "expressivity",
    "noise",
    "reverb",
    "quality",
];
// The subset that stays Parler-only now that emotion/pace are cross-engine.
exports.PARLER_ONLY_TEMPLATE_KEYS = [
    "voice",
    "pitch",
    "expressivity",
    "noise",
    "reverb",
    "quality",
];
exports.PARLER_FIELD_KEYS = [
    ...exports.PARLER_DESCRIPTION_KEYS,
    ...exports.PARLER_TEMPLATE_KEYS,
];
exports.PARLER_ONLY_KEYS = [
    ...exports.PARLER_DESCRIPTION_KEYS,
    ...exports.PARLER_ONLY_TEMPLATE_KEYS,
];
/**
 * Find a Parler GGUF in `modelDir`, ranked by variant (mini before large
 * before indic) and, within a variant, by quant tier (q8_0 > q6_k > f16 > f32;
 * a bare `parler-<variant>.gguf` wins as forward-compat).
 */
function findParlerInDir(modelDir) {
    if (!modelDir)
        return undefined;
    let entries;
    try {
        entries = fs.readdirSync(modelDir);
    }
    catch {
        return undefined;
    }
    const matches = entries.filter((name) => exports.PARLER_RE.test(name));
    if (matches.length === 0)
        return undefined;
    function rank(name) {
        const match = name.match(exports.PARLER_RE);
        if (!match)
            return Number.MAX_SAFE_INTEGER;
        const variant = exports.PARLER_VARIANT_ORDER.indexOf(match[1].toLowerCase());
        let quantRank = 0;
        if (match[3]) {
            const index = exports.PARLER_QUANT_ORDER.indexOf(match[3].slice(1).toLowerCase());
            quantRank =
                index === -1 ? exports.PARLER_QUANT_ORDER.length + 2 : index + 1;
        }
        return variant * 100 + quantRank;
    }
    matches.sort((left, right) => rank(left) - rank(right));
    return path.join(modelDir, matches[0]);
}
/**
 * Collect the Parler description/template properties present on `source`
 * (a run input, streaming options, or constructor options). Returns undefined
 * when none are set.
 */
function pickParlerDescFields(source) {
    if (source == null || typeof source !== "object")
        return undefined;
    const out = {};
    let any = false;
    for (const key of exports.PARLER_FIELD_KEYS) {
        const value = source[key];
        if (value != null && value !== "") {
            out[key] = String(value);
            any = true;
        }
    }
    return any ? out : undefined;
}
/**
 * Same-level conflict check: a free-text description cannot be merged with
 * template fields, so setting both together is an error.
 */
function assertParlerDescFieldsConsistent(fields, where) {
    if (!fields)
        return;
    const hasDescription = exports.PARLER_DESCRIPTION_KEYS.some((key) => fields[key] != null);
    const templateKeys = exports.PARLER_TEMPLATE_KEYS.filter((key) => fields[key] != null);
    if (hasDescription && templateKeys.length > 0) {
        throw new Error(`tts-ggml: ${where}: 'description' is mutually exclusive with the ` +
            `voice-template options (got ${templateKeys.join(", ")})`);
    }
}
function resolveParlerModelPaths(files) {
    return {
        parlerModelPath: (0, modelFiles_1.firstNonEmpty)(files.parlerModel, files.modelDir ? findParlerInDir(files.modelDir) : undefined),
    };
}
/**
 * Constructor-time rules: on Parler the description and template fields are
 * mutually exclusive; on every other engine the Parler-only options are
 * rejected by name.
 */
function assertParlerOptions(setup) {
    if (setup.engineType === engineIds_1.ENGINE_PARLER) {
        assertParlerDescFieldsConsistent(pickParlerDescFields({
            description: setup.settings.description,
            voice: setup.settings.voice,
            emotion: setup.settings.emotion,
            pitch: setup.settings.pitch,
            pace: setup.settings.pace,
            expressivity: setup.settings.expressivity,
            noise: setup.settings.noise,
            reverb: setup.settings.reverb,
            quality: setup.settings.quality,
        }), "constructor");
        return;
    }
    const parlerOnly = [];
    if (setup.settings.description != null) {
        parlerOnly.push("description/voiceDescription");
    }
    // emotion / pace are absent because they are cross-engine, validated by
    // assertConditioningConsistency; temperature / topK / topP / maxFrames are
    // absent because audio8 samples too, so SAMPLING_ENGINES decides them.
    parlerOnly.push(...(0, options_1.setOptionNames)({
        pitch: setup.settings.pitch,
        expressivity: setup.settings.expressivity,
        noise: setup.settings.noise,
        reverb: setup.settings.reverb,
        quality: setup.settings.quality,
        minNewTokens: setup.settings.minNewTokens,
        normalizeNumbers: setup.settings.normalizeNumbers,
    }));
    if (parlerOnly.length > 0) {
        throw new Error(`tts-ggml: ${parlerOnly.join(", ")} are parler-only options ` +
            `(engine is ${setup.engineType})`);
    }
}
/**
 * Parler's per-call surface: description/template fields, where a per-call
 * template cannot be merged with a constructor-level free-text description.
 */
function resolveParlerJobFields(setup, source, where) {
    const fields = pickParlerDescFields(source);
    if (!fields)
        return undefined;
    assertParlerDescFieldsConsistent(fields, where);
    const conditioning = (0, conditioning_1.pickConditioningFields)(source);
    (0, conditioning_1.validateConditioning)(setup.engineType, conditioning);
    (0, conditioning_1.assertPerCallConditioning)(setup.engineType, conditioning, where);
    const hasDescription = exports.PARLER_DESCRIPTION_KEYS.some((key) => fields[key] != null);
    if (!hasDescription && setup.settings.description != null) {
        throw new Error(`tts-ggml: ${where}: per-call template options cannot be combined ` +
            "with a constructor-level description; pass a per-call " +
            "description instead");
    }
    return fields;
}
function buildParlerParams(setup) {
    // Re-checked here (not only in the constructor) so reload({...}) cannot
    // smuggle in a description/template conflict.
    if (setup.settings.description != null) {
        const templateSet = [
            setup.settings.voice,
            setup.settings.emotion,
            setup.settings.pitch,
            setup.settings.pace,
            setup.settings.expressivity,
            setup.settings.noise,
            setup.settings.reverb,
            setup.settings.quality,
        ].some((value) => value != null && value !== "");
        if (templateSet) {
            throw new Error("tts-ggml: 'description' is mutually exclusive with the " +
                "voice-template options");
        }
    }
    const parameters = {
        engineType: engineIds_1.ENGINE_PARLER,
        parlerModelPath: setup.paths.parlerModelPath || "",
    };
    if (setup.settings.description != null) {
        parameters.description = String(setup.settings.description);
    }
    if (setup.settings.voice)
        parameters.voice = String(setup.settings.voice);
    if (setup.settings.emotion != null) {
        parameters.emotion = String(setup.settings.emotion);
    }
    if (setup.settings.pitch != null)
        parameters.pitch = String(setup.settings.pitch);
    if (setup.settings.pace != null)
        parameters.pace = String(setup.settings.pace);
    if (setup.settings.expressivity != null) {
        parameters.expressivity = String(setup.settings.expressivity);
    }
    if (setup.settings.noise != null)
        parameters.noise = String(setup.settings.noise);
    if (setup.settings.reverb != null)
        parameters.reverb = String(setup.settings.reverb);
    if (setup.settings.quality != null) {
        parameters.quality = String(setup.settings.quality);
    }
    (0, nativeParams_1.assignSamplingParams)(setup, parameters);
    if (setup.settings.minNewTokens != null) {
        parameters.minNewTokens = setup.settings.minNewTokens | 0;
    }
    if (setup.settings.streamChunkTokens != null) {
        parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
    }
    if (setup.settings.streamFirstChunkTokens != null) {
        parameters.streamFirstChunkTokens =
            setup.settings.streamFirstChunkTokens | 0;
    }
    if (setup.settings.normalizeNumbers != null) {
        parameters.normalizeNumbers = !!setup.settings.normalizeNumbers;
    }
    (0, nativeParams_1.assignBackendParams)(setup, parameters);
    return parameters;
}
/** The template and sampler settings a Parler reload may rewrite one by one. */
const PARLER_RELOADABLE_KEYS = [
    "voice",
    "pitch",
    "expressivity",
    "noise",
    "reverb",
    "quality",
    "temperature",
    "topK",
    "topP",
    "maxFrames",
    "minNewTokens",
    "normalizeNumbers",
    "seed",
];
/**
 * Parler description/template + sampling knobs are reloadable; they rebuild
 * the engine's default description / sampler. `buildParlerParams`
 * re-validates afterwards, so a description/template conflict introduced by a
 * reload still throws (and the caller rolls the settings back).
 */
function applyParlerReload(setup, newConfig) {
    if (setup.engineType !== engineIds_1.ENGINE_PARLER)
        return;
    const config = newConfig;
    if (config.description !== undefined ||
        config.voiceDescription !== undefined) {
        setup.settings.description = (0, modelFiles_1.firstNonEmpty)(config.description, config.voiceDescription);
    }
    for (const key of PARLER_RELOADABLE_KEYS) {
        const value = config[key];
        if (value !== undefined)
            Object.assign(setup.settings, { [key]: value });
    }
}
