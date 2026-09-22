"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
const path = require("bare-path");
const file_paths_1 = require("./file-paths");
/**
 * Projects a load against the memory free right now, reading model metadata
 * and never weight data. A GGUF file set can be a weightless registry copy,
 * so the projection can run before anything is downloaded; a safetensors file
 * still needs its tensor data present.
 *
 * A model the engine cannot read is `status: "error"`; only a broken request
 * throws.
 */
function assessFit(request) {
    (0, file_paths_1.assertFilePaths)(request.files);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('./binding.js');
    if (typeof binding.assessFit !== 'function') {
        throw new Error('the diffusion-cpp prebuild does not expose assessFit');
    }
    // The native side reads the config sub-object as a string map, the same way
    // createInstance does.
    const merged = { ...request.config };
    if (!merged.backendsDir) {
        merged.backendsDir = path.join(__dirname, 'prebuilds');
    }
    const config = Object.fromEntries(Object.entries(merged)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]));
    return binding.assessFit({
        ...(0, file_paths_1.toFilePaths)(request.files),
        config,
        request: request.workload ?? {}
    });
}
