"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPERTONIC_V3_QUANT_ORDER = exports.SUPERTONIC_V3_RE = exports.SUPERTONIC_MTL = exports.SUPERTONIC_DEFAULT = void 0;
exports.findSupertonicV3InDir = findSupertonicV3InDir;
exports.hasSupertonicModelDir = hasSupertonicModelDir;
exports.resolveSupertonicModelPaths = resolveSupertonicModelPaths;
exports.buildSupertonicParams = buildSupertonicParams;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const engineIds_1 = require("../engineIds");
const modelFiles_1 = require("../modelFiles");
const nativeParams_1 = require("../nativeParams");
exports.SUPERTONIC_DEFAULT = "supertonic.gguf";
exports.SUPERTONIC_MTL = "supertonic2.gguf";
exports.SUPERTONIC_V3_RE = /^supertonic3(-[a-z0-9_]+)?\.gguf$/i;
exports.SUPERTONIC_V3_QUANT_ORDER = [
    "f16",
    "f32",
    "q8_0",
    "q4_0",
];
function findSupertonicV3InDir(modelDir) {
    if (!modelDir)
        return undefined;
    let entries;
    try {
        entries = fs.readdirSync(modelDir);
    }
    catch {
        return undefined;
    }
    const matches = entries.filter((name) => exports.SUPERTONIC_V3_RE.test(name));
    if (matches.length === 0)
        return undefined;
    function rank(name) {
        if (/^supertonic3\.gguf$/i.test(name))
            return 0;
        const match = name.match(/^supertonic3-(.+)\.gguf$/i);
        const index = match
            ? exports.SUPERTONIC_V3_QUANT_ORDER.indexOf(match[1].toLowerCase())
            : -1;
        return index === -1
            ? exports.SUPERTONIC_V3_QUANT_ORDER.length + 1
            : index + 1;
    }
    matches.sort((left, right) => rank(left) - rank(right));
    return path.join(modelDir, matches[0]);
}
function hasSupertonicModelDir(modelDir) {
    return ((0, modelFiles_1.fileExistsSafe)(path.join(modelDir, exports.SUPERTONIC_DEFAULT)) ||
        (0, modelFiles_1.fileExistsSafe)(path.join(modelDir, exports.SUPERTONIC_MTL)) ||
        !!findSupertonicV3InDir(modelDir));
}
function resolveSupertonicModelDirPath(modelDir) {
    const english = path.join(modelDir, exports.SUPERTONIC_DEFAULT);
    const multilingual = path.join(modelDir, exports.SUPERTONIC_MTL);
    const versionThree = findSupertonicV3InDir(modelDir);
    if ((0, modelFiles_1.fileExistsSafe)(english))
        return english;
    if ((0, modelFiles_1.fileExistsSafe)(multilingual))
        return multilingual;
    if (versionThree)
        return versionThree;
    return english;
}
function resolveSupertonicModelPaths(files) {
    return {
        supertonicModelPath: (0, modelFiles_1.firstNonEmpty)(files.supertonicModel, files.modelDir ? resolveSupertonicModelDirPath(files.modelDir) : undefined),
    };
}
function buildSupertonicParams(setup) {
    const parameters = {
        engineType: engineIds_1.ENGINE_SUPERTONIC,
        supertonicModelPath: setup.paths.supertonicModelPath || "",
        language: setup.config.language || "en",
    };
    (0, nativeParams_1.assignCommonNativeParams)(setup, parameters);
    if (setup.settings.voice)
        parameters.voice = setup.settings.voice;
    if (setup.settings.steps != null)
        parameters.steps = setup.settings.steps | 0;
    if (setup.settings.speed != null)
        parameters.speed = Number(setup.settings.speed);
    // The native layer maps the step onto a multiplier relative to the GGUF's
    // own default_speed, and rejects pace + speed together.
    if (setup.settings.pace != null)
        parameters.pace = String(setup.settings.pace);
    if (setup.settings.noiseNpyPath) {
        parameters.noiseNpyPath = setup.settings.noiseNpyPath;
    }
    if (setup.backend.vulkanCacheDir) {
        parameters.vulkanCacheDir = setup.backend.vulkanCacheDir;
    }
    if (setup.settings.voiceJsonPath)
        parameters.voiceJsonPath = setup.settings.voiceJsonPath;
    if (setup.settings.prewarmText)
        parameters.prewarmText = setup.settings.prewarmText;
    if (setup.settings.vulkanDevice != null) {
        parameters.vulkanDevice = setup.settings.vulkanDevice | 0;
    }
    if (setup.settings.streamChunkTokens != null) {
        parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
    }
    if (setup.settings.streamFirstChunkTokens != null) {
        parameters.streamFirstChunkTokens = setup.settings.streamFirstChunkTokens | 0;
    }
    if (setup.settings.streamChunkTolerancePct != null) {
        parameters.streamChunkTolerancePct = setup.settings.streamChunkTolerancePct | 0;
    }
    if (setup.settings.streamMinChunkTokens != null) {
        parameters.streamMinChunkTokens = setup.settings.streamMinChunkTokens | 0;
    }
    return parameters;
}
