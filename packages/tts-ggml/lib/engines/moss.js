"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOSS_INSTANCE_VOICE_KEYS = exports.MOSS_MAX_DURATION_TOKENS = exports.MOSS_TERMINATION_ROWS = exports.MOSS_MAX_CHANNELS = exports.MOSS_MAX_NEW_TOKENS = exports.MOSS_FRAMES_PER_SECOND = exports.MOSS_NATIVE_SAMPLE_RATE = exports.MOSS_ENCODER_RE = exports.MOSS_DECODER_RE = exports.MOSS_DIALOGUE_BACKBONE_RE = exports.MOSS_BACKBONE_RE = void 0;
exports.assertMossDurationTokens = assertMossDurationTokens;
exports.resolveMossModelPaths = resolveMossModelPaths;
exports.mossVoiceSettings = mossVoiceSettings;
exports.assertMossOptions = assertMossOptions;
exports.assertMossOutputRate = assertMossOutputRate;
exports.buildMossParams = buildMossParams;
exports.assertMossReloadKeepsVoice = assertMossReloadKeepsVoice;
exports.applyMossReload = applyMossReload;
const engineIds_1 = require("../engineIds");
const modelFiles_1 = require("../modelFiles");
const nativeParams_1 = require("../nativeParams");
const options_1 = require("../options");
exports.MOSS_BACKBONE_RE = /^moss-tts-delay(-[a-z0-9_]+)?\.gguf$/i;
exports.MOSS_DIALOGUE_BACKBONE_RE = /^moss-ttsd(-[a-z0-9_]+)?\.gguf$/i;
exports.MOSS_DECODER_RE = /^moss-codec-decoder(-[a-z0-9_]+)?\.gguf$/i;
exports.MOSS_ENCODER_RE = /^moss-codec-encoder(-[a-z0-9_]+)?\.gguf$/i;
exports.MOSS_NATIVE_SAMPLE_RATE = 24000;
exports.MOSS_FRAMES_PER_SECOND = 12.5;
exports.MOSS_MAX_NEW_TOKENS = 2048;
exports.MOSS_MAX_CHANNELS = 32;
exports.MOSS_TERMINATION_ROWS = 2;
exports.MOSS_MAX_DURATION_TOKENS = exports.MOSS_MAX_NEW_TOKENS - (exports.MOSS_MAX_CHANNELS - 1) - exports.MOSS_TERMINATION_ROWS;
exports.MOSS_INSTANCE_VOICE_KEYS = ["referenceAudio", "dialogueReferences"];
function isValidDurationTokens(value) {
    return Number.isInteger(value) && value >= 0 && value <= exports.MOSS_MAX_DURATION_TOKENS;
}
function assertMossDurationTokens(value, where) {
    if (value == null || isValidDurationTokens(value))
        return;
    throw new Error(`tts-ggml: ${where}: durationTokens must be an integer from 0 to ` +
        `${exports.MOSS_MAX_DURATION_TOKENS} (0 = free length)`);
}
function copyDialogueReferences(references) {
    if (references == null)
        return undefined;
    return Array.isArray(references)
        ? [...references]
        : references;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value !== "";
}
function assertDialogueReferenceList(references) {
    if (Array.isArray(references) &&
        references.length > 0 &&
        references.every(isNonEmptyString)) {
        return;
    }
    throw new Error("tts-ggml: dialogueReferences must be a non-empty array of WAV paths, " +
        "one per speaker");
}
/** Dialogue synthesis needs the MOSS-TTSD backbone; plain TTS takes either. */
function mossBackbonePatterns(dialogue) {
    return dialogue
        ? [exports.MOSS_DIALOGUE_BACKBONE_RE]
        : [exports.MOSS_BACKBONE_RE, exports.MOSS_DIALOGUE_BACKBONE_RE];
}
function findMossBackbone(modelDir, dialogue) {
    return (0, modelFiles_1.firstNonEmpty)(...mossBackbonePatterns(dialogue).map((pattern) => (0, modelFiles_1.findQuantRankedGguf)(modelDir, pattern)));
}
function resolveMossModelPaths(files, dialogue) {
    return {
        mossBackbonePath: (0, modelFiles_1.firstNonEmpty)(files.mossBackbone, findMossBackbone(files.modelDir, dialogue)),
        mossCodecDecoderPath: (0, modelFiles_1.firstNonEmpty)(files.mossCodecDecoder, (0, modelFiles_1.findQuantRankedGguf)(files.modelDir, exports.MOSS_DECODER_RE)),
        mossCodecEncoderPath: (0, modelFiles_1.firstNonEmpty)(files.mossCodecEncoder, (0, modelFiles_1.findQuantRankedGguf)(files.modelDir, exports.MOSS_ENCODER_RE)),
    };
}
/** The MOSS voice and length options, read before model paths are resolved. */
function mossVoiceSettings(options) {
    return {
        dialogueReferences: copyDialogueReferences(options.dialogueReferences),
        durationTokens: options.durationTokens ?? undefined,
    };
}
function assertMossOptions(setup) {
    if (setup.engineType !== engineIds_1.ENGINE_MOSS) {
        assertNoMossOnlyOptions(setup);
        return;
    }
    if (setup.backend.enhancerGgufPath || setup.backend.denoiserGgufPath) {
        throw new Error("tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
            "the moss engine. Drop lavasrEnhancer / lavasrDenoiser.");
    }
    assertMossOutputRate(setup);
    assertMossVoiceConsistent(setup);
    assertMossDurationTokens(setup.settings.durationTokens, "constructor");
    assertMossDialogueReferences(setup);
}
function assertNoMossOnlyOptions(setup) {
    const mossOnly = (0, options_1.setOptionNames)({
        durationTokens: setup.settings.durationTokens,
        dialogueReferences: setup.settings.dialogueReferences !== undefined || undefined,
    });
    if (mossOnly.length === 0)
        return;
    throw new Error(`tts-ggml: ${mossOnly.join(", ")} are moss-only options ` +
        `(engine is ${setup.engineType})`);
}
function assertMossDialogueReferences(setup) {
    if (setup.settings.dialogueReferences === undefined)
        return;
    assertDialogueReferenceList(setup.settings.dialogueReferences);
    if (setup.settings.referenceAudio) {
        throw new Error("tts-ggml: referenceAudio and dialogueReferences are exclusive; " +
            "pass one recording per speaker in dialogueReferences");
    }
    if (!setup.paths.mossCodecEncoderPath) {
        throw new Error("tts-ggml: dialogue synthesis with the moss engine needs the codec " +
            "encoder GGUF (files.mossCodecEncoder)");
    }
    if (!setup.paths.mossBackbonePath) {
        throw new Error("tts-ggml: dialogue synthesis with the moss engine needs the MOSS-TTSD " +
            "backbone: stage moss-ttsd-*.gguf in modelDir or set files.mossBackbone");
    }
}
function assertMossOutputRate(setup) {
    if (setup.outputSampleRate == null ||
        setup.outputSampleRate === exports.MOSS_NATIVE_SAMPLE_RATE) {
        return;
    }
    throw new Error(`tts-ggml: the moss engine emits ${exports.MOSS_NATIVE_SAMPLE_RATE} Hz only; ` +
        `drop outputSampleRate (got ${setup.outputSampleRate}).`);
}
function assertMossVoiceConsistent(setup) {
    if (!setup.settings.referenceAudio || setup.paths.mossCodecEncoderPath)
        return;
    throw new Error("tts-ggml: voice cloning with the moss engine needs the codec " +
        "encoder GGUF (files.mossCodecEncoder)");
}
function buildMossParams(setup) {
    assertMossOutputRate(setup);
    const parameters = {
        engineType: engineIds_1.ENGINE_MOSS,
        mossBackbonePath: setup.paths.mossBackbonePath || "",
        mossCodecDecoderPath: setup.paths.mossCodecDecoderPath || "",
        language: setup.config.language || "en",
    };
    if (setup.paths.mossCodecEncoderPath) {
        parameters.mossCodecEncoderPath = setup.paths.mossCodecEncoderPath;
    }
    if (setup.settings.referenceAudio != null) {
        parameters.referenceAudio = setup.settings.referenceAudio;
    }
    if (setup.settings.dialogueReferences) {
        parameters.dialogueReferences = [...setup.settings.dialogueReferences];
    }
    if (setup.settings.durationTokens != null) {
        parameters.durationTokens = setup.settings.durationTokens | 0;
    }
    if (setup.settings.streamChunkTokens != null) {
        parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
    }
    (0, nativeParams_1.assignBackendParams)(setup, parameters);
    return parameters;
}
function assertMossReloadKeepsVoice(setup, newConfig) {
    if (setup.engineType !== engineIds_1.ENGINE_MOSS)
        return;
    const voiceKeys = exports.MOSS_INSTANCE_VOICE_KEYS.filter((key) => newConfig[key] !== undefined);
    if (voiceKeys.length === 0)
        return;
    throw new Error(`tts-ggml: reload: the moss engine encodes ${voiceKeys.join(", ")} ` +
        "once per instance; create a new instance to clone different recordings");
}
function applyMossReload(setup, newConfig) {
    if (setup.engineType !== engineIds_1.ENGINE_MOSS)
        return;
    const durationTokens = newConfig
        .durationTokens;
    if (durationTokens === undefined)
        return;
    assertMossDurationTokens(durationTokens, "reload");
    setup.settings.durationTokens = durationTokens ?? undefined;
}
