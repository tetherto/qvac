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
 */
function assessFit(request) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('./binding.js');
    return binding.assessFit({
        backendsDir: (0, addon_1.resolveBackendsDir)(),
        ...request
    });
}
