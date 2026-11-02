"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEngineOptions = validateEngineOptions;
/**
 * Constructor-time option validation, in the order the errors are reported:
 * streaming capability, Parler, sampler and engine-scoped options, then each
 * engine's own consistency rules, cross-engine conditioning, and finally the
 * denoiser's batch-only rule.
 */
const conditioning_1 = require("./conditioning");
const engineIds_1 = require("./engineIds");
const audio8_1 = require("./engines/audio8");
const cosyvoice_1 = require("./engines/cosyvoice");
const moss_1 = require("./engines/moss");
const mossSoundEffect_1 = require("./engines/mossSoundEffect");
const mossSpeech_1 = require("./engines/mossSpeech");
const parler_1 = require("./engines/parler");
const options_1 = require("./options");
const streamingSupport_1 = require("./streamingSupport");
function validateEngineOptions(setup) {
    (0, streamingSupport_1.assertChunkStreamingSupport)(setup);
    // Runs before the denoiser guard so a Parler description/template conflict
    // is reported ahead of the engine-agnostic streaming constraints.
    (0, parler_1.assertParlerOptions)(setup);
    assertSamplerOptionSupport(setup);
    assertEngineScopedOptions(setup);
    (0, cosyvoice_1.assertCosyvoiceOptionConsistency)(setup);
    (0, cosyvoice_1.assertCosyvoiceCloneConsistent)(setup);
    (0, audio8_1.assertAudio8Options)(setup);
    (0, moss_1.assertMossOptions)(setup);
    (0, mossSoundEffect_1.assertMossSoundEffectOptions)(setup);
    (0, mossSpeech_1.assertMossSpeechOptions)(setup);
    (0, conditioning_1.assertConditioningConsistency)(setup, "constructor");
    (0, streamingSupport_1.assertDenoiserBatchOnly)(setup);
}
function assertSamplerOptionSupport(setup) {
    if (setup.engineType === engineIds_1.ENGINE_POCKET || engineIds_1.SAMPLING_ENGINES.includes(setup.engineType))
        return;
    // Chatterbox's T3 samples too, but its length cap is nPredict, not maxFrames.
    const tokenSampling = setup.engineType === engineIds_1.ENGINE_CHATTERBOX
        ? {}
        : {
            temperature: setup.settings.temperature,
            topK: setup.settings.topK,
            topP: setup.settings.topP,
        };
    const sampling = (0, options_1.setOptionNames)({
        ...tokenSampling,
        maxFrames: setup.settings.maxFrames,
    });
    if (sampling.length === 0)
        return;
    throw new Error(`tts-ggml: ${sampling.join(", ")} are parler/audio8-only options ` +
        `(engine is ${setup.engineType})`);
}
/**
 * Options only some engines read. Set on any other engine they would be
 * dropped without effect, so they are rejected by name instead.
 */
function assertEngineScopedOptions(setup) {
    const scoped = [
        [
            [engineIds_1.ENGINE_CHATTERBOX],
            {
                batchCfmSteps: setup.settings.batchCfmSteps,
                nPredict: setup.settings.nPredict,
                maxSentenceChars: setup.settings.maxSentenceChars,
                crossfadeMs: setup.settings.crossfadeMs,
                repeatPenalty: setup.settings.repeatPenalty,
                exaggeration: setup.settings.exaggeration,
                cfgWeight: setup.settings.cfgWeight,
                minP: setup.settings.minP,
            },
        ],
        [
            [engineIds_1.ENGINE_CHATTERBOX, engineIds_1.ENGINE_COSYVOICE3],
            { streamLeftContextTokens: setup.settings.streamLeftContextTokens },
        ],
        [
            [engineIds_1.ENGINE_SUPERTONIC],
            {
                voiceJsonPath: setup.settings.voiceJsonPath,
                prewarmText: setup.settings.prewarmText,
                streamChunkTolerancePct: setup.settings.streamChunkTolerancePct,
                streamMinChunkTokens: setup.settings.streamMinChunkTokens,
            },
        ],
        [
            [engineIds_1.ENGINE_SUPERTONIC, engineIds_1.ENGINE_COSYVOICE3],
            { vulkanDevice: setup.settings.vulkanDevice },
        ],
        [[engineIds_1.ENGINE_COSYVOICE3], { flowCutPrompt: setup.settings.flowCutPrompt }],
    ];
    for (const [engines, fields] of scoped) {
        if (engines.includes(setup.engineType))
            continue;
        const names = (0, options_1.setOptionNames)(fields);
        if (names.length === 0)
            continue;
        throw new Error(`tts-ggml: ${names.join(", ")} are ${engines.join("/")}-only ` +
            `options (engine is ${setup.engineType})`);
    }
}
