"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectEngineType = detectEngineType;
exports.resolveModelPaths = resolveModelPaths;
/**
 * Engine discovery: which engine a `files` object selects, and the model paths
 * that engine loads. Precedence: an explicit `engine` option, then explicit
 * per-engine file keys, then the contents of a shared `modelDir`.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
const engineIds_1 = require("./engineIds");
const audio8_1 = require("./engines/audio8");
const chatterbox_1 = require("./engines/chatterbox");
const cosyvoice_1 = require("./engines/cosyvoice");
const moss_1 = require("./engines/moss");
const mossSoundEffect_1 = require("./engines/mossSoundEffect");
const mossSpeech_1 = require("./engines/mossSpeech");
const parler_1 = require("./engines/parler");
const supertonic_1 = require("./engines/supertonic");
const modelFiles_1 = require("./modelFiles");
const POCKET_FLOW_LM = "flow-lm.gguf";
function detectEngineType(engine, files) {
    if ((0, engineIds_1.isEngineType)(engine))
        return engine;
    if (engine != null && engine !== "") {
        throw new Error("tts-ggml: 'engine' option must be 'chatterbox', 'supertonic', " +
            `'cosyvoice3', 'parler', 'audio8', 'moss', 'moss-sfx', 'moss-speech' or 'pocket' (got '${String(engine)}')`);
    }
    return (engineFromExplicitFiles(files) ??
        (files.modelDir ? engineFromModelDir(files.modelDir) : undefined) ??
        engineIds_1.ENGINE_CHATTERBOX);
}
/** Explicit per-engine file keys, in precedence order. */
function engineFromExplicitFiles(files) {
    if (files.pocketFlowModel || files.pocketMimiModel)
        return engineIds_1.ENGINE_POCKET;
    // Explicit CosyVoice3 files/dir take precedence over shared-modelDir sniffing.
    if (files.cosyvoiceModelDir || files.cosyvoiceLlmModel) {
        return engineIds_1.ENGINE_COSYVOICE3;
    }
    if (files.t3Model || files.s3genModel)
        return engineIds_1.ENGINE_CHATTERBOX;
    if (files.supertonicModel)
        return engineIds_1.ENGINE_SUPERTONIC;
    if (files.parlerModel)
        return engineIds_1.ENGINE_PARLER;
    if (files.audio8Lm || files.audio8CodecDecoder)
        return engineIds_1.ENGINE_AUDIO8;
    if (files.mossBackbone || files.mossCodecDecoder)
        return engineIds_1.ENGINE_MOSS;
    if (files.mossSoundEffect)
        return engineIds_1.ENGINE_MOSS_SFX;
    if (files.mossSpeechModel || files.mossSpeechCodec)
        return engineIds_1.ENGINE_MOSS_SPEECH;
    return undefined;
}
/** What a shared `modelDir` holds, in precedence order. */
function engineFromModelDir(modelDir) {
    if ((0, cosyvoice_1.dirHasCosyvoice3)(modelDir))
        return engineIds_1.ENGINE_COSYVOICE3;
    if ((0, chatterbox_1.hasChatterboxModelDir)(modelDir))
        return engineIds_1.ENGINE_CHATTERBOX;
    if ((0, supertonic_1.hasSupertonicModelDir)(modelDir))
        return engineIds_1.ENGINE_SUPERTONIC;
    if ((0, parler_1.findParlerInDir)(modelDir))
        return engineIds_1.ENGINE_PARLER;
    if ((0, modelFiles_1.findQuantRankedGguf)(modelDir, audio8_1.AUDIO8_LM_RE))
        return engineIds_1.ENGINE_AUDIO8;
    if ((0, modelFiles_1.findQuantRankedGguf)(modelDir, moss_1.MOSS_BACKBONE_RE))
        return engineIds_1.ENGINE_MOSS;
    if ((0, modelFiles_1.findQuantRankedGguf)(modelDir, moss_1.MOSS_DIALOGUE_BACKBONE_RE))
        return engineIds_1.ENGINE_MOSS;
    if ((0, modelFiles_1.findQuantRankedGguf)(modelDir, mossSoundEffect_1.MOSS_SFX_RE))
        return engineIds_1.ENGINE_MOSS_SFX;
    if ((0, modelFiles_1.findQuantRankedGguf)(modelDir, mossSpeech_1.MOSS_SPEECH_RE))
        return engineIds_1.ENGINE_MOSS_SPEECH;
    if ((0, modelFiles_1.fileExistsSafe)(path.join(modelDir, POCKET_FLOW_LM)))
        return engineIds_1.ENGINE_POCKET;
    return undefined;
}
/** The model files `engineType` loads: explicit paths first, then `modelDir`. */
function resolveModelPaths(engineType, files, options) {
    const shared = {
        voicesDir: files.voicesDir,
        mecabDictPath: (0, modelFiles_1.firstNonEmpty)(options.mecabDictPath, options.mecabDictDir, files.mecabDictDir),
        cangjieTsvPath: (0, modelFiles_1.firstNonEmpty)(options.cangjieTsvPath, files.cangjieTsvPath),
    };
    switch (engineType) {
        case engineIds_1.ENGINE_POCKET:
            return shared;
        case engineIds_1.ENGINE_COSYVOICE3:
            return { ...shared, ...(0, cosyvoice_1.resolveCosyvoiceModelPaths)(files) };
        case engineIds_1.ENGINE_SUPERTONIC:
            return { ...shared, ...(0, supertonic_1.resolveSupertonicModelPaths)(files) };
        case engineIds_1.ENGINE_PARLER:
            return { ...shared, ...(0, parler_1.resolveParlerModelPaths)(files) };
        case engineIds_1.ENGINE_AUDIO8:
            return { ...shared, ...(0, audio8_1.resolveAudio8ModelPaths)(files) };
        case engineIds_1.ENGINE_MOSS:
            return { ...shared, ...(0, moss_1.resolveMossModelPaths)(files, options.dialogue) };
        case engineIds_1.ENGINE_MOSS_SFX:
            return { ...shared, ...(0, mossSoundEffect_1.resolveMossSoundEffectModelPaths)(files) };
        case engineIds_1.ENGINE_MOSS_SPEECH:
            return { ...shared, ...(0, mossSpeech_1.resolveMossSpeechModelPaths)(files) };
        default:
            return { ...shared, ...(0, chatterbox_1.resolveChatterboxModelPaths)(files) };
    }
}
