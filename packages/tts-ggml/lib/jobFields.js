"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveJobFields = resolveJobFields;
const conditioning_1 = require("./conditioning");
const engineIds_1 = require("./engineIds");
const audio8_1 = require("./engines/audio8");
const cosyvoice_1 = require("./engines/cosyvoice");
const mossSoundEffect_1 = require("./engines/mossSoundEffect");
const mossSpeech_1 = require("./engines/mossSpeech");
const parler_1 = require("./engines/parler");
const options_1 = require("./options");
/**
 * The per-call surface of a non-Parler engine: only the cross-engine
 * emotion/pace it declares support for, never Parler's template fields.
 */
function resolveConditioningJobFields(setup, source, where, instruct) {
    const parlerOnly = (0, options_1.keysPresent)(source, parler_1.PARLER_ONLY_KEYS);
    if (parlerOnly.length > 0) {
        throw new Error(`tts-ggml: ${where}: per-call description/voice-template options ` +
            `are parler-only (engine is ${setup.engineType}; got ` +
            `${parlerOnly.join(", ")})`);
    }
    const fields = (0, conditioning_1.pickConditioningFields)(source);
    if (!fields)
        return undefined;
    (0, conditioning_1.validateConditioning)(setup.engineType, fields);
    (0, conditioning_1.assertPerCallConditioning)(setup.engineType, fields, where);
    if (setup.engineType === engineIds_1.ENGINE_COSYVOICE3) {
        // A per-call control replaces the constructor's, so only the per-call
        // fields participate in the one-instruction count.
        (0, conditioning_1.assertSingleCosyvoiceControl)(fields, instruct, where);
    }
    return fields;
}
function assertNoSpeechFields(setup, source, where) {
    const fields = (0, mossSpeech_1.pickSpeechFields)(source);
    if (!fields)
        return;
    throw new Error(`tts-ggml: ${where}: ${Object.keys(fields).join(", ")} are ` +
        `moss-speech-only options (engine is ${setup.engineType})`);
}
function assertNoOtherEngineFields(setup, source, where) {
    resolveConditioningJobFields(setup, source, where, (0, cosyvoice_1.resolveJobInstruct)(setup, source, where));
    (0, audio8_1.resolveAudio8JobFields)(setup, source, where);
    (0, mossSoundEffect_1.resolveSoundEffectJobFields)(setup, source, where);
}
/**
 * The per-call fields of whichever engine is loaded, if any are set. Parler
 * takes the full description/template surface, Audio8 its voice override,
 * and every engine the cross-engine conditioning it supports.
 */
function resolveJobFields(setup, source, where) {
    if (setup.engineType === engineIds_1.ENGINE_MOSS_SPEECH) {
        assertNoOtherEngineFields(setup, source, where);
        return (0, mossSpeech_1.resolveSpeechJobFields)(source, where);
    }
    const instruct = (0, cosyvoice_1.resolveJobInstruct)(setup, source, where);
    const engineFields = setup.engineType === engineIds_1.ENGINE_PARLER
        ? (0, parler_1.resolveParlerJobFields)(setup, source, where)
        : resolveConditioningJobFields(setup, source, where, instruct);
    const audio8 = (0, audio8_1.resolveAudio8JobFields)(setup, source, where);
    const soundEffect = (0, mossSoundEffect_1.resolveSoundEffectJobFields)(setup, source, where);
    assertNoSpeechFields(setup, source, where);
    if (!engineFields && !audio8 && !soundEffect && instruct === undefined) {
        return undefined;
    }
    return {
        ...(engineFields ?? {}),
        ...(audio8 ?? {}),
        ...(soundEffect ?? {}),
        ...(instruct === undefined ? {} : { instruct }),
    };
}
