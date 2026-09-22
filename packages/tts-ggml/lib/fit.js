"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
const backends_1 = require("./backends");
/**
 * Projects one voice against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of each file answers
 * the same as the file itself, so this can run before anything is downloaded.
 *
 * `engineType` picks the fitter, the same key a load uses, and is required
 * here: a fit request carries none of the file keys a load is inferred from.
 * A model the engine cannot read comes back as `status: "error"`; a broken
 * request, or a host with no native binding, throws.
 */
function assessFit(request) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('../binding.js');
    return binding.assessFit({
        ...request,
        backendsDir: typeof request.backendsDir === 'string' && request.backendsDir.length > 0
            ? request.backendsDir
            : (0, backends_1.resolveBackendsDir)()
    });
}
