"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertFilePaths = assertFilePaths;
exports.toFilePaths = toFilePaths;
/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
const path = require("bare-path");
const COMPANION_FILE_KEYS = [
    'clipL',
    'clipG',
    't5Xxl',
    'llm',
    'vae',
    'esrgan',
    'highNoiseDiffusionModel',
    'uncondModel',
    'clipVision',
    'audioVae',
    'embeddingsConnectors'
];
function assertAbsolute(key, value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`files.${key} must be an absolute path string`);
    }
    if (!path.isAbsolute(value)) {
        throw new TypeError(`files.${key} must be an absolute path (got: ${value})`);
    }
}
/**
 * Rejects a file set the engine could only report as an opaque error. Shared
 * so a fit refuses the same paths a load refuses.
 */
function assertFilePaths(files) {
    assertAbsolute('model', files.model);
    for (const key of COMPANION_FILE_KEYS) {
        if (files[key] !== undefined) {
            assertAbsolute(key, files[key]);
        }
    }
}
/**
 * Maps a file set onto the keys the engine reads. A split layout carries the
 * diffusion weights under their own key and leaves `path` empty, which is how
 * the engine tells the two layouts apart.
 *
 * Shared with the image load so a fit of the same files describes them the
 * same way. The video load maps its own, keeping the weights under
 * `diffusionModelPath` whatever the companion set holds.
 */
function toFilePaths(files) {
    const isSplitLayout = !!files.llm || !!files.t5Xxl || !!files.clipL || !!files.clipG;
    return {
        path: isSplitLayout ? '' : files.model,
        diffusionModelPath: isSplitLayout ? files.model : '',
        highNoiseDiffusionModelPath: files.highNoiseDiffusionModel || '',
        uncondDiffusionModelPath: files.uncondModel || '',
        clipLPath: files.clipL || '',
        clipGPath: files.clipG || '',
        t5XxlPath: files.t5Xxl || '',
        llmPath: files.llm || '',
        vaePath: files.vae || '',
        clipVisionPath: files.clipVision || '',
        esrganPath: files.esrgan || '',
        audioVaePath: files.audioVae || '',
        embeddingsConnectorsPath: files.embeddingsConnectors || ''
    };
}
