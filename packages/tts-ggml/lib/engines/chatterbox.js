"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHATTERBOX_S3GEN_MTL = exports.CHATTERBOX_S3GEN_DEFAULT = exports.CHATTERBOX_T3_MTL = exports.CHATTERBOX_T3_TURBO = void 0;
exports.hasChatterboxModelDir = hasChatterboxModelDir;
exports.resolveChatterboxModelPaths = resolveChatterboxModelPaths;
exports.buildChatterboxParams = buildChatterboxParams;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const path = require("bare-path");
const engineIds_1 = require("../engineIds");
const modelFiles_1 = require("../modelFiles");
const nativeParams_1 = require("../nativeParams");
exports.CHATTERBOX_T3_TURBO = "chatterbox-t3-turbo.gguf";
exports.CHATTERBOX_T3_MTL = "chatterbox-t3-mtl.gguf";
exports.CHATTERBOX_S3GEN_DEFAULT = "chatterbox-s3gen.gguf";
exports.CHATTERBOX_S3GEN_MTL = "chatterbox-s3gen-mtl.gguf";
function hasChatterboxModelDir(modelDir) {
    return ((0, modelFiles_1.fileExistsSafe)(path.join(modelDir, exports.CHATTERBOX_T3_TURBO)) ||
        (0, modelFiles_1.fileExistsSafe)(path.join(modelDir, exports.CHATTERBOX_T3_MTL)));
}
function resolveChatterboxModelDirPaths(modelDir) {
    const turboT3 = path.join(modelDir, exports.CHATTERBOX_T3_TURBO);
    const multilingualT3 = path.join(modelDir, exports.CHATTERBOX_T3_MTL);
    const defaultS3 = path.join(modelDir, exports.CHATTERBOX_S3GEN_DEFAULT);
    const multilingualS3 = path.join(modelDir, exports.CHATTERBOX_S3GEN_MTL);
    if ((0, modelFiles_1.fileExistsSafe)(multilingualT3) &&
        !(0, modelFiles_1.fileExistsSafe)(turboT3)) {
        return {
            t3: multilingualT3,
            s3: (0, modelFiles_1.fileExistsSafe)(multilingualS3)
                ? multilingualS3
                : defaultS3,
        };
    }
    return { t3: turboT3, s3: defaultS3 };
}
function resolveChatterboxModelPaths(files) {
    if (!files.modelDir) {
        return { t3ModelPath: files.t3Model, s3genModelPath: files.s3genModel };
    }
    const resolved = resolveChatterboxModelDirPaths(files.modelDir);
    return {
        t3ModelPath: (0, modelFiles_1.firstNonEmpty)(files.t3Model, resolved.t3),
        s3genModelPath: (0, modelFiles_1.firstNonEmpty)(files.s3genModel, resolved.s3),
    };
}
function buildChatterboxParams(setup) {
    const parameters = {
        engineType: engineIds_1.ENGINE_CHATTERBOX,
        t3ModelPath: setup.paths.t3ModelPath || "",
        s3genModelPath: setup.paths.s3genModelPath || "",
        language: setup.config.language || "en",
    };
    (0, nativeParams_1.assignCommonNativeParams)(setup, parameters);
    if (setup.settings.referenceAudio != null) {
        parameters.referenceAudio = setup.settings.referenceAudio;
    }
    if (setup.settings.voiceDir != null)
        parameters.voiceDir = setup.settings.voiceDir;
    if (setup.settings.nCtx != null)
        parameters.nCtx = setup.settings.nCtx | 0;
    if (setup.settings.kvCacheType != null) {
        parameters.kvCacheType = String(setup.settings.kvCacheType);
    }
    if (setup.settings.streamChunkTokens != null) {
        parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
    }
    if (setup.settings.streamFirstChunkTokens != null) {
        parameters.streamFirstChunkTokens =
            setup.settings.streamFirstChunkTokens | 0;
    }
    if (setup.settings.cfmSteps != null) {
        parameters.cfmSteps = setup.settings.cfmSteps | 0;
    }
    if (setup.settings.streamLeftContextTokens != null) {
        parameters.streamLeftContextTokens = setup.settings.streamLeftContextTokens | 0;
    }
    if (setup.settings.batchCfmSteps != null) {
        parameters.batchCfmSteps = setup.settings.batchCfmSteps | 0;
    }
    if (setup.settings.cfgRate != null) {
        parameters.cfgRate = Number(setup.settings.cfgRate);
    }
    if (setup.settings.nPredict != null)
        parameters.nPredict = setup.settings.nPredict | 0;
    if (setup.settings.maxSentenceChars != null) {
        parameters.maxSentenceChars = setup.settings.maxSentenceChars | 0;
    }
    if (setup.settings.crossfadeMs != null) {
        parameters.crossfadeMs = setup.settings.crossfadeMs | 0;
    }
    (0, nativeParams_1.assignSamplingParams)(setup, parameters);
    if (setup.settings.repeatPenalty != null) {
        parameters.repeatPenalty = Number(setup.settings.repeatPenalty);
    }
    if (setup.settings.exaggeration != null) {
        parameters.exaggeration = Number(setup.settings.exaggeration);
    }
    if (setup.settings.cfgWeight != null) {
        parameters.cfgWeight = Number(setup.settings.cfgWeight);
    }
    if (setup.settings.minP != null)
        parameters.minP = Number(setup.settings.minP);
    if (setup.settings.speed != null)
        parameters.speed = Number(setup.settings.speed);
    if (setup.paths.mecabDictPath) {
        parameters.mecabDictPath = setup.paths.mecabDictPath;
    }
    if (setup.paths.cangjieTsvPath) {
        parameters.cangjieTsvPath = setup.paths.cangjieTsvPath;
    }
    return parameters;
}
