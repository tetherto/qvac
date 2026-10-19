"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.firstNonEmpty = firstNonEmpty;
exports.fileExistsSafe = fileExistsSafe;
exports.readDirSafe = readDirSafe;
exports.ggufQuantRank = ggufQuantRank;
exports.findQuantRankedGguf = findQuantRankedGguf;
exports.normalizeGgmlFiles = normalizeGgmlFiles;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
function firstNonEmpty(...candidates) {
    for (const value of candidates) {
        if (value != null && value !== "")
            return value;
    }
    return undefined;
}
function fileExistsSafe(filePath) {
    if (!filePath)
        return false;
    try {
        return fs.existsSync(filePath);
    }
    catch {
        return false;
    }
}
/**
 * Preferred quant tier when a model directory holds several copies of the same
 * GGUF (Audio8 and MOSS): the tier that reads best for its size.
 */
const QUANT_TIER_ORDER = ["q8_0", "f16", "q4_0", "f32"];
function readDirSafe(modelDir) {
    if (!modelDir)
        return [];
    try {
        return fs.readdirSync(modelDir);
    }
    catch {
        return [];
    }
}
function ggufQuantRank(name, pattern) {
    const match = name.match(pattern);
    if (!match)
        return Number.MAX_SAFE_INTEGER;
    if (!match[1])
        return 0;
    const index = QUANT_TIER_ORDER.indexOf(match[1].slice(1).toLowerCase());
    return index === -1 ? QUANT_TIER_ORDER.length + 1 : index + 1;
}
/**
 * Find one Audio8 or MOSS GGUF in `modelDir`, preferring the quant tier that
 * reads best for its size (q8_0 > f16 > q4_0 > f32).
 */
function findQuantRankedGguf(modelDir, pattern) {
    if (!modelDir)
        return undefined;
    const matches = readDirSafe(modelDir).filter((name) => pattern.test(name));
    if (matches.length === 0)
        return undefined;
    matches.sort((left, right) => ggufQuantRank(left, pattern) - ggufQuantRank(right, pattern));
    return path.join(modelDir, matches[0]);
}
function normalizeGgmlFiles(files) {
    if (files == null || typeof files !== "object")
        return {};
    return {
        modelDir: firstNonEmpty(files.modelDir),
        pocketFlowModel: firstNonEmpty(files.pocketFlowModel),
        pocketMimiModel: firstNonEmpty(files.pocketMimiModel),
        pocketFrontend: firstNonEmpty(files.pocketFrontend),
        pocketVoice: firstNonEmpty(files.pocketVoice),
        t3Model: firstNonEmpty(files.t3Model, files.t3ModelPath, files.t3),
        s3genModel: firstNonEmpty(files.s3genModel, files.s3genModelPath, files.s3gen),
        supertonicModel: firstNonEmpty(files.supertonicModel, files.supertonicModelPath, files.supertonic),
        // CosyVoice3: either a dedicated modelDir of cosyvoice3-*.gguf files, or
        // explicit per-component paths. Falls back to the shared `modelDir`.
        cosyvoiceModelDir: firstNonEmpty(files.cosyvoiceModelDir),
        cosyvoiceLlmModel: firstNonEmpty(files.cosyvoiceLlmModel, files.cosyvoiceLlmModelPath),
        cosyvoiceFlowModel: firstNonEmpty(files.cosyvoiceFlowModel, files.cosyvoiceFlowModelPath),
        cosyvoiceHiftModel: firstNonEmpty(files.cosyvoiceHiftModel, files.cosyvoiceHiftModelPath),
        cosyvoiceS3tokModel: firstNonEmpty(files.cosyvoiceS3tokModel, files.cosyvoiceS3tokModelPath),
        cosyvoiceCampplusModel: firstNonEmpty(files.cosyvoiceCampplusModel, files.cosyvoiceCampplusModelPath),
        cosyvoiceVocab: firstNonEmpty(files.cosyvoiceVocab, files.cosyvoiceVocabPath),
        cosyvoiceMerges: firstNonEmpty(files.cosyvoiceMerges, files.cosyvoiceMergesPath),
        cosyvoiceVoiceModel: firstNonEmpty(files.cosyvoiceVoiceModel, files.cosyvoiceVoiceModelPath),
        parlerModel: firstNonEmpty(files.parlerModel, files.parlerModelPath, files.parler),
        audio8Lm: firstNonEmpty(files.audio8Lm, files.audio8LmPath),
        audio8CodecDecoder: firstNonEmpty(files.audio8CodecDecoder, files.audio8CodecDecoderPath),
        audio8CodecEncoder: firstNonEmpty(files.audio8CodecEncoder, files.audio8CodecEncoderPath),
        mossBackbone: firstNonEmpty(files.mossBackbone, files.mossBackbonePath),
        mossCodecDecoder: firstNonEmpty(files.mossCodecDecoder, files.mossCodecDecoderPath),
        mossCodecEncoder: firstNonEmpty(files.mossCodecEncoder, files.mossCodecEncoderPath),
        mossSoundEffect: firstNonEmpty(files.mossSoundEffect, files.mossSoundEffectPath),
        mossSpeechModel: firstNonEmpty(files.mossSpeechModel, files.mossSpeechModelPath),
        mossSpeechCodec: firstNonEmpty(files.mossSpeechCodec, files.mossSpeechCodecPath),
        voicesDir: firstNonEmpty(files.voicesDir),
        lavasrEnhancer: firstNonEmpty(files.lavasrEnhancer),
        lavasrDenoiser: firstNonEmpty(files.lavasrDenoiser),
        mecabDictDir: firstNonEmpty(files.mecabDictDir, files.mecabDictPath),
        cangjieTsvPath: firstNonEmpty(files.cangjieTsvPath, files.cangjieTsv),
    };
}
