"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
const driver_1 = require("../engines/moss/driver");
/**
 * Projects one model against the memory free right now, reading model metadata
 * and never weight data. Parakeet is GGUF, so the registry's weightless copy of
 * a parakeet model answers the same as the model itself. Whisper ships as
 * `.bin`, which the registry has no weightless form for.
 *
 * MOSS-Transcribe requires `audioSeconds`; `prompt`, `hotwords`, and
 * `maxNewTokens` use the transcription rules and model defaults. Its
 * projection includes the chunked encoder, prefill/decode, and KV cache.
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the native binding loads on first use.
    const binding = require('../binding.js');
    if (request.engine === 'moss-transcribe') {
        (0, driver_1.mossTranscribeJobFields)({
            prompt: request.prompt,
            hotwords: request.hotwords,
            maxNewTokens: request.maxNewTokens
        });
    }
    return binding.assessFit(request);
}
