"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_ALIAS_TABLE = void 0;
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
/**
 * Alias table behind `normalizeGgmlFiles`: one row per `NormalizedFiles` key,
 * the canonical key first and then its aliases in precedence order. The first
 * non-empty value in a row wins, so the canonical key beats every alias and an
 * earlier alias beats a later one.
 */
exports.FILE_ALIAS_TABLE = [
    ["modelDir"],
    ["pocketFlowModel"],
    ["pocketMimiModel"],
    ["pocketFrontend"],
    ["pocketVoice"],
    ["t3Model", "t3ModelPath", "t3"],
    ["s3genModel", "s3genModelPath", "s3gen"],
    ["supertonicModel", "supertonicModelPath", "supertonic"],
    // CosyVoice3: either a dedicated modelDir of cosyvoice3-*.gguf files, or
    // explicit per-component paths. Falls back to the shared `modelDir`.
    ["cosyvoiceModelDir"],
    ["cosyvoiceLlmModel", "cosyvoiceLlmModelPath"],
    ["cosyvoiceFlowModel", "cosyvoiceFlowModelPath"],
    ["cosyvoiceHiftModel", "cosyvoiceHiftModelPath"],
    ["cosyvoiceS3tokModel", "cosyvoiceS3tokModelPath"],
    ["cosyvoiceCampplusModel", "cosyvoiceCampplusModelPath"],
    ["cosyvoiceVocab", "cosyvoiceVocabPath"],
    ["cosyvoiceMerges", "cosyvoiceMergesPath"],
    ["cosyvoiceVoiceModel", "cosyvoiceVoiceModelPath"],
    ["parlerModel", "parlerModelPath", "parler"],
    ["audio8Lm", "audio8LmPath"],
    ["audio8CodecDecoder", "audio8CodecDecoderPath"],
    ["audio8CodecEncoder", "audio8CodecEncoderPath"],
    ["mossBackbone", "mossBackbonePath"],
    ["mossCodecDecoder", "mossCodecDecoderPath"],
    ["mossCodecEncoder", "mossCodecEncoderPath"],
    ["mossSoundEffect", "mossSoundEffectPath"],
    ["mossSpeechModel", "mossSpeechModelPath"],
    ["mossSpeechCodec", "mossSpeechCodecPath"],
    ["voicesDir"],
    ["lavasrEnhancer"],
    ["lavasrDenoiser"],
    ["mecabDictDir", "mecabDictPath"],
    ["cangjieTsvPath", "cangjieTsv"],
];
function normalizeGgmlFiles(files) {
    if (files == null || typeof files !== "object")
        return {};
    const normalized = {};
    for (const row of exports.FILE_ALIAS_TABLE) {
        normalized[row[0]] = firstNonEmpty(...row.map((key) => files[key]));
    }
    return normalized;
}
