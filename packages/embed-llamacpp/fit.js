"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
const addon_1 = require("./addon");
/**
 * Projects one model against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of a model answers the
 * same as the model itself, so this can run before anything is downloaded.
 *
 * A model the fitter cannot read comes back as `status: "error"`; only a broken
 * request throws.
 *
 * Runs synchronously on the calling thread and builds the model twice without
 * allocating weights, so a caller that must stay responsive runs it off its
 * own loop.
 *
 * The projection reads the model's vocabulary, and llama asserts on a
 * vocabulary it finds inconsistent. An assert aborts rather than throwing, so
 * a corrupt file ends the process instead of returning a status: take the
 * model from a source you trust, or call this behind a process boundary.
 */
function assessFit(request) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('./binding.js');
    return binding.assessFit({
        ...request,
        backendsDir: typeof request.backendsDir === 'string' && request.backendsDir.length > 0
            ? request.backendsDir
            : (0, addon_1.resolveBackendsDir)()
    });
}
