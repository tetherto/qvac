"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
const backends_1 = require("./backends");
/**
 * Projects one model against the memory free right now, reading model metadata
 * and never weight data. Parakeet is GGUF, so the registry's weightless copy of
 * a parakeet model answers the same as the model itself. Whisper ships as
 * `.bin`, which the registry has no weightless form for.
 *
 * `engine` picks the fitter and defaults to parakeet. With `gpuLayers`
 * omitted, parakeet projects on the CPU and whisper on the GPU, matching what
 * each load does. `marginBytes` defaults to the engine's own headroom, which
 * is 256 MiB for parakeet.
 *
 * A model the fitter cannot read comes back as `status: "error"` with the
 * engine's reason. Only a broken request throws.
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
