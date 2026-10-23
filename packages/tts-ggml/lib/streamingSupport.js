"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestsChunkStreaming = requestsChunkStreaming;
exports.assertChunkStreamingSupport = assertChunkStreamingSupport;
exports.assertDenoiserBatchOnly = assertDenoiserBatchOnly;
exports.assertSentenceStreamingAllowed = assertSentenceStreamingAllowed;
const engineIds_1 = require("./engineIds");
const moss_1 = require("./engines/moss");
// Every streaming engine starts native chunk streaming on
// streamChunkTokens > 0 alone: a count of 0 means batch, and
// streamFirstChunkTokens only sizes the first chunk once streaming is on.
function requestsChunkStreaming(settings) {
    return (settings.streamChunkTokens ?? 0) > 0;
}
/** Native chunk streaming against what the engine can actually do. */
function assertChunkStreamingSupport(setup) {
    const { engineType, settings, backend } = setup;
    // Checked ahead of the shared denoiser guard: Supertonic rejects both
    // LavaSR stages for one reason (tts-cpp has only one-shot enhance /
    // denoise, and the engine reports no native rate before synthesis).
    if (engineType === engineIds_1.ENGINE_SUPERTONIC &&
        (backend.enhancerGgufPath || backend.denoiserGgufPath) &&
        requestsChunkStreaming(settings)) {
        throw new Error("tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
            "supertonic native chunk streaming (streamChunkTokens > 0). Use " +
            "batch synthesis or sentence-level streaming via runStream() / " +
            "runStreaming() / run({ streamOutput: true }) for enhanced or " +
            "denoised output.");
    }
    if (engineType === engineIds_1.ENGINE_AUDIO8 &&
        (settings.streamChunkTokens != null ||
            settings.streamFirstChunkTokens != null)) {
        throw new Error("tts-ggml: streamChunkTokens / streamFirstChunkTokens are not " +
            "supported by the audio8 engine, which uses fixed codec windows. " +
            "Use incremental PCM streaming via " +
            "runStream() / runStreaming() / run({ streamOutput: true }).");
    }
    if ((engineType === engineIds_1.ENGINE_MOSS_SFX || engineType === engineIds_1.ENGINE_MOSS_SPEECH) &&
        (settings.streamChunkTokens != null ||
            settings.streamFirstChunkTokens != null)) {
        throw new Error("tts-ggml: streamChunkTokens / streamFirstChunkTokens are not " +
            `supported by the ${engineType} engine, which returns a ` +
            "whole result at a time. Use run().");
    }
    if (engineType === engineIds_1.ENGINE_MOSS && settings.streamFirstChunkTokens != null) {
        throw new Error("tts-ggml: streamFirstChunkTokens is not supported by the moss " +
            "engine, which streams fixed-size chunks; set streamChunkTokens " +
            `(codec frames per chunk, ${moss_1.MOSS_FRAMES_PER_SECOND} per second) only.`);
    }
}
/** The LavaSR denoiser has no streaming form yet. */
function assertDenoiserBatchOnly(setup) {
    if (!setup.backend.denoiserGgufPath || !requestsChunkStreaming(setup.settings)) {
        return;
    }
    throw new Error("tts-ggml: the LavaSR denoiser is not yet supported with " +
        "native chunk streaming (streamChunkTokens > 0). Use batch " +
        "synthesis, or drop the denoiser for streaming. Streaming " +
        "denoise is a planned follow-up (needs a stateful streaming " +
        "denoiser).");
}
/** Sentence-level streaming (runStream / runStreaming / streamOutput). */
function assertSentenceStreamingAllowed(setup, where) {
    if (setup.engineType === engineIds_1.ENGINE_MOSS_SPEECH) {
        throw new Error(`tts-ggml: ${where}: the moss-speech engine answers one turn at a ` +
            "time and does not stream; use run()");
    }
    if (setup.engineType === engineIds_1.ENGINE_MOSS_SFX) {
        throw new Error(`tts-ggml: ${where}: the moss-sfx engine generates a whole sound ` +
            "effect from one prompt and does not stream; use run()");
    }
    if (setup.settings.dialogueReferences === undefined)
        return;
    throw new Error(`tts-ggml: ${where}: MOSS dialogue cannot be split into sentences, ` +
        "because every job must open with the reference transcripts; use " +
        "run() or native streaming (streamChunkTokens)");
}
