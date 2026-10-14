"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
/**
 * Projects one voice against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of each file answers
 * the same as the file itself, so this can run before anything is downloaded.
 *
 * The request is a `createInstance` config plus the workload, and the engine's
 * own config builder reads it, so a load that runs and a fit that describes it
 * resolve their settings the same way.
 *
 * `engineType` picks the fitter, the same key a load uses, and is required
 * here: a fit request carries none of the file keys a load is inferred from.
 * A model the engine cannot read comes back as `status: "error"`, as does a
 * voice with no fitter; a broken request, or a host with no native binding,
 * throws.
 */
function assessFit(request) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the native binding loads on first use.
    const binding = require('../binding.js');
    return binding.assessFit(request);
}
