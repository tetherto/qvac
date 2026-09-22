"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
const path = require("bare-path");
const file_paths_1 = require("./file-paths");
/**
 * Projects a load against the memory free right now, reading model metadata
 * and never weight data. The registry's weightless copy of each file answers
 * the same as the file itself, so this can run before anything is downloaded.
 *
 * A model the engine cannot read is `status: "error"`; only a broken request
 * throws.
 */
function assessFit(request) {
    (0, file_paths_1.assertFilePaths)(request.files);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('./binding.js');
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
