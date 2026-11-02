"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COSYVOICE_DISENGAGED = exports.CONDITIONING_KEYS = exports.PACES = exports.EMOTIONS = void 0;
exports.pickConditioningFields = pickConditioningFields;
exports.assertCanonicalValue = assertCanonicalValue;
exports.supportedValues = supportedValues;
exports.assertEngineSupports = assertEngineSupports;
exports.validateConditioning = validateConditioning;
exports.assertPerCallConditioning = assertPerCallConditioning;
exports.engagedCosyvoiceControls = engagedCosyvoiceControls;
exports.assertSingleCosyvoiceControl = assertSingleCosyvoiceControl;
exports.assertConditioningConsistency = assertConditioningConsistency;
const engineIds_1 = require("./engineIds");
// Canonical cross-engine conditioning vocabulary. This is a MIRROR, not the
// source of truth: tts-cpp owns it in include/tts-cpp/voice_controls.h, and
// test/unit/voice-controls.test.js pins this copy against the native lists.
exports.EMOTIONS = [
    "command",
    "anger",
    "narration",
    "conversation",
    "disgust",
    "fear",
    "happy",
    "neutral",
    "proper noun",
    "news",
    "sad",
    "surprise",
];
exports.PACES = ["slow", "moderate", "fast"];
exports.CONDITIONING_KEYS = ["emotion", "pace"];
// Per-engine supported subsets, mirroring controls::supported_emotions() /
// supported_paces(). An empty list means the engine has no such control.
const ENGINE_EMOTIONS = {
    [engineIds_1.ENGINE_PARLER]: exports.EMOTIONS,
    // Only the emotions Fun-CosyVoice3 has a trained instruction for; the rest,
    // and the upstream spelling "angry", are rejected rather than paraphrased.
    [engineIds_1.ENGINE_COSYVOICE3]: ["anger", "happy", "neutral", "sad"],
    [engineIds_1.ENGINE_SUPERTONIC]: [],
    [engineIds_1.ENGINE_CHATTERBOX]: [],
    [engineIds_1.ENGINE_POCKET]: [],
    [engineIds_1.ENGINE_AUDIO8]: [],
    [engineIds_1.ENGINE_MOSS]: [],
    [engineIds_1.ENGINE_MOSS_SFX]: [],
    [engineIds_1.ENGINE_MOSS_SPEECH]: [],
};
const ENGINE_PACES = {
    [engineIds_1.ENGINE_PARLER]: exports.PACES, // rendered into the training caption
    [engineIds_1.ENGINE_COSYVOICE3]: exports.PACES, // slow/fast -> instruct; moderate -> none
    [engineIds_1.ENGINE_SUPERTONIC]: exports.PACES, // mapped onto the duration multiplier
    [engineIds_1.ENGINE_CHATTERBOX]: [], // time-stretch only; use `speed`
    [engineIds_1.ENGINE_POCKET]: [],
    [engineIds_1.ENGINE_AUDIO8]: [], // no rate control at all
    [engineIds_1.ENGINE_MOSS]: [],
    [engineIds_1.ENGINE_MOSS_SFX]: [],
    [engineIds_1.ENGINE_MOSS_SPEECH]: [],
};
// Which channels an engine can change per call. Supertonic takes its pace
// through EngineOptions when the engine is built, and tts-cpp exposes no
// per-call surface for it, so it only moves at construction or reload().
// tts-cpp engine names (tts-cpp/voice_controls.h engine_name) that differ from
const ENGINE_PER_CALL_CONDITIONING = {
    [engineIds_1.ENGINE_PARLER]: exports.CONDITIONING_KEYS,
    [engineIds_1.ENGINE_COSYVOICE3]: exports.CONDITIONING_KEYS,
    [engineIds_1.ENGINE_SUPERTONIC]: [],
    [engineIds_1.ENGINE_CHATTERBOX]: [],
    [engineIds_1.ENGINE_POCKET]: [],
    [engineIds_1.ENGINE_AUDIO8]: [],
    [engineIds_1.ENGINE_MOSS]: [],
    [engineIds_1.ENGINE_MOSS_SFX]: [],
    [engineIds_1.ENGINE_MOSS_SPEECH]: [],
};
/** Collect the cross-engine conditioning properties present on `source`. */
function pickConditioningFields(source) {
    if (source == null || typeof source !== "object")
        return undefined;
    const out = {};
    let any = false;
    for (const key of exports.CONDITIONING_KEYS) {
        const value = source[key];
        if (value != null && value !== "") {
            out[key] = value;
            any = true;
        }
    }
    return any ? out : undefined;
}
function assertCanonicalValue(value, canonical, kind) {
    if (canonical.includes(value.toLowerCase()))
        return;
    throw new Error(`tts-ggml: invalid ${kind} "${value}". ` +
        `Valid ${kind}s: ${canonical.join(", ")}.`);
}
function supportedValues(engine, kind) {
    return kind === "emotion" ? ENGINE_EMOTIONS[engine] : ENGINE_PACES[engine];
}
function assertEngineSupports(engine, kind, value) {
    const supported = supportedValues(engine, kind);
    if (supported.length === 0) {
        const hint = kind === "pace"
            ? "; use `speed` (an exact multiplier) instead"
            : "";
        throw new Error(`tts-ggml: the ${engine} engine does not support \`${kind}\`${hint}`);
    }
    if (supported.includes(value.toLowerCase()))
        return;
    throw new Error(`tts-ggml: ${kind} "${value}" is not supported by the ${engine} engine. ` +
        `${engine} supports: ${supported.join(", ")}.`);
}
/**
 * Validate emotion/pace against the canonical vocabulary first (so a typo reads
 * clearly), then against what this engine actually supports.
 */
function validateConditioning(engine, fields) {
    if (!fields)
        return;
    if (fields.emotion != null) {
        assertCanonicalValue(fields.emotion, exports.EMOTIONS, "emotion");
        assertEngineSupports(engine, "emotion", fields.emotion);
    }
    if (fields.pace != null) {
        assertCanonicalValue(fields.pace, exports.PACES, "pace");
        assertEngineSupports(engine, "pace", fields.pace);
    }
}
/**
 * Reject a channel the engine supports but cannot change per call, so it is
 * never accepted here and then dropped on the way to the engine. Runs after
 * validateConditioning so an engine with no such control keeps its own message.
 */
function assertPerCallConditioning(engine, fields, where) {
    if (!fields)
        return;
    const perCall = ENGINE_PER_CALL_CONDITIONING[engine];
    const fixed = exports.CONDITIONING_KEYS.filter((key) => fields[key] != null && !perCall.includes(key));
    if (fixed.length === 0)
        return;
    throw new Error(`tts-ggml: ${where}: ${engine} applies ` +
        `${fixed.map((key) => `\`${key}\``).join(", ")} when the engine is ` +
        `built, so it cannot change per call; set it in the constructor or ` +
        `reload({ ${fixed.join(", ")} })`);
}
// CosyVoice3 is trained on one instruction per synthesis. Only `pace: moderate`
// resolves to no instruction, so it is the one value that never conflicts; every
// emotion carries a trained instruction, `neutral` included.
exports.COSYVOICE_DISENGAGED = {
    pace: "moderate",
};
function engagedCosyvoiceControls(fields, instruct) {
    const engaged = [];
    for (const key of exports.CONDITIONING_KEYS) {
        const value = fields?.[key];
        if (value != null && value.toLowerCase() !== exports.COSYVOICE_DISENGAGED[key]) {
            engaged.push(`${key}="${value}"`);
        }
    }
    if (instruct != null && instruct !== "")
        engaged.push("instruct");
    return engaged;
}
function assertSingleCosyvoiceControl(fields, instruct, where) {
    const engaged = engagedCosyvoiceControls(fields, instruct);
    if (engaged.length <= 1)
        return;
    throw new Error(`tts-ggml: ${where}: conflicting conditioning controls ` +
        `(${engaged.join(", ")}); cosyvoice3 is trained on one instruction per ` +
        `synthesis -- set exactly one (pace="moderate" disengages a channel)`);
}
/**
 * Validate the configured emotion/pace against this engine, and enforce
 * CosyVoice3's one-instruction-per-synthesis rule. Runs at construction and
 * again after a reload rewrites either channel.
 */
function assertConditioningConsistency(setup, where) {
    const fields = pickConditioningFields({
        emotion: setup.settings.emotion,
        pace: setup.settings.pace,
    });
    validateConditioning(setup.engineType, fields);
    if (setup.engineType === engineIds_1.ENGINE_COSYVOICE3) {
        assertSingleCosyvoiceControl(fields, setup.settings.instruct, where);
    }
}
