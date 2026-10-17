"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDefaultLazySessionLoading = resolveDefaultLazySessionLoading;
exports.validateOutputSampleRate = validateOutputSampleRate;
exports.assertGpuIntentConsistent = assertGpuIntentConsistent;
exports.resolveEngineSetup = resolveEngineSetup;
/**
 * Turns constructor options into an `EngineSetup`: normalized files, the
 * detected engine and its model paths, synthesis settings, backend paths, and
 * (for Pocket) the native parameters, validated in the order the wrapper has
 * always reported them.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const bareOs = require("bare-os");
/* eslint-enable @typescript-eslint/no-require-imports */
const engineDetection_1 = require("./engineDetection");
const engineIds_1 = require("./engineIds");
const cosyvoice_1 = require("./engines/cosyvoice");
const moss_1 = require("./engines/moss");
const modelFiles_1 = require("./modelFiles");
const optionValidation_1 = require("./optionValidation");
const pocketConfig_1 = require("./pocketConfig");
const { platform } = bareOs;
const MIN_OUTPUT_SAMPLE_RATE = 8000;
const MAX_OUTPUT_SAMPLE_RATE = 192000;
function resolveDefaultLazySessionLoading(lazySessionLoading) {
    if (lazySessionLoading != null)
        return lazySessionLoading;
    return platform() === "ios" || platform() === "android";
}
function validateOutputSampleRate(outputSampleRate) {
    if (outputSampleRate == null)
        return null;
    if (outputSampleRate < MIN_OUTPUT_SAMPLE_RATE ||
        outputSampleRate > MAX_OUTPUT_SAMPLE_RATE) {
        throw new Error(`outputSampleRate must be between ${MIN_OUTPUT_SAMPLE_RATE} and ` +
            `${MAX_OUTPUT_SAMPLE_RATE}, got ${outputSampleRate}`);
    }
    return outputSampleRate;
}
function resolveEnhancerGgufPath(files, enhancer) {
    if (enhancer != null && enhancer.type !== "lavasr") {
        throw new Error(`tts-ggml: unknown enhancer.type '${String(enhancer.type)}', expected 'lavasr'.`);
    }
    return (0, modelFiles_1.firstNonEmpty)(files.lavasrEnhancer, enhancer?.enhancerPath);
}
function resolveDenoiserGgufPath(files, denoiser) {
    if (denoiser != null && denoiser.type !== "lavasr") {
        throw new Error(`tts-ggml: unknown denoiser.type '${String(denoiser.type)}', expected 'lavasr'.`);
    }
    return (0, modelFiles_1.firstNonEmpty)(files.lavasrDenoiser, denoiser?.denoiserPath);
}
function assertGpuIntentConsistent(useGPU, nGpuLayers) {
    if (typeof useGPU !== "boolean" || nGpuLayers == null)
        return;
    if (useGPU === (nGpuLayers !== 0))
        return;
    throw new Error(`tts-ggml: useGPU=${String(useGPU)} conflicts with ` +
        `nGpuLayers=${nGpuLayers}. Either drop one of the two, or make ` +
        "them agree (useGPU:true + nGpuLayers!=0, or " +
        "useGPU:false + nGpuLayers=0).");
}
/** Synthesis options with their aliases collapsed; may throw on a malformed `instruct`. */
function settingsFromOptions(options) {
    return {
        referenceAudio: options.referenceAudio,
        referenceText: options.referenceText,
        greedy: options.greedy,
        voiceDir: options.voiceDir,
        seed: options.seed,
        nGpuLayers: options.nGpuLayers,
        nCtx: options.nCtx,
        kvCacheType: options.kvCacheType,
        threads: options.threads,
        streamChunkTokens: options.streamChunkTokens,
        streamFirstChunkTokens: options.streamFirstChunkTokens,
        streamChunkTolerancePct: options.streamChunkTolerancePct,
        streamMinChunkTokens: options.streamMinChunkTokens,
        streamLeftContextTokens: options.streamLeftContextTokens,
        cfmSteps: options.cfmSteps,
        cfgRate: options.cfgRate,
        batchCfmSteps: options.batchCfmSteps,
        nPredict: options.nPredict,
        maxSentenceChars: options.maxSentenceChars,
        crossfadeMs: options.crossfadeMs,
        repeatPenalty: options.repeatPenalty,
        exaggeration: options.exaggeration,
        cfgWeight: options.cfgWeight,
        minP: options.minP,
        voiceJsonPath: options.voiceJsonPath,
        prewarmText: options.prewarmText,
        vulkanDevice: options.vulkanDevice,
        flowCutPrompt: options.flowCutPrompt,
        promptText: options.promptText,
        instruct: (0, cosyvoice_1.renderCosyvoiceInstruct)(options.instruct) || undefined,
        voice: (0, modelFiles_1.firstNonEmpty)(options.voice, options.voiceName),
        steps: (0, modelFiles_1.firstNonEmpty)(options.steps, options.numInferenceSteps),
        speed: options.speed,
        noiseNpyPath: options.noiseNpyPath,
        description: (0, modelFiles_1.firstNonEmpty)(options.description, options.voiceDescription),
        emotion: options.emotion,
        pitch: options.pitch,
        pace: options.pace,
        expressivity: options.expressivity,
        noise: options.noise,
        reverb: options.reverb,
        quality: options.quality,
        temperature: options.temperature,
        topK: options.topK,
        topP: options.topP,
        maxFrames: options.maxFrames,
        minNewTokens: options.minNewTokens,
        normalizeNumbers: options.normalizeNumbers,
        ...(0, moss_1.mossVoiceSettings)(options),
    };
}
function resolveBackendPaths(files, options, config) {
    return {
        enhancerGgufPath: resolveEnhancerGgufPath(files, options.enhancer),
        denoiserGgufPath: resolveDenoiserGgufPath(files, options.denoiser),
        backendsDir: (0, modelFiles_1.firstNonEmpty)(options.backendsDir, config.backendsDir),
        openclCacheDir: (0, modelFiles_1.firstNonEmpty)(options.openclCacheDir, config.openclCacheDir),
        vulkanCacheDir: (0, modelFiles_1.firstNonEmpty)(options.vulkanCacheDir, config.vulkanCacheDir),
    };
}
function resolvePocketSetup(files, options, config) {
    if (files.lavasrEnhancer || files.lavasrDenoiser) {
        throw new Error("Pocket does not support LavaSR enhancement or denoising");
    }
    return {
        files,
        options: { ...options },
        params: (0, pocketConfig_1.buildPocketParams)(files, options, config),
    };
}
/** Resolve and validate everything the constructor derives from `options`. */
function resolveEngineSetup(options) {
    const files = (0, modelFiles_1.normalizeGgmlFiles)(options.files || {});
    const config = { ...(options.config || {}) };
    const outputSampleRate = validateOutputSampleRate(config.outputSampleRate);
    const engineType = (0, engineDetection_1.detectEngineType)(options.engine, files);
    const mossVoice = (0, moss_1.mossVoiceSettings)(options);
    const pocket = engineType === engineIds_1.ENGINE_POCKET
        ? resolvePocketSetup(files, options, config)
        : null;
    const paths = (0, engineDetection_1.resolveModelPaths)(engineType, files, {
        mecabDictPath: options.mecabDictPath,
        mecabDictDir: options.mecabDictDir,
        cangjieTsvPath: options.cangjieTsvPath,
        dialogue: mossVoice.dialogueReferences !== undefined,
    });
    const settings = settingsFromOptions(options);
    const backend = resolveBackendPaths(files, options, config);
    const setup = {
        engineType,
        config,
        outputSampleRate,
        paths,
        settings,
        backend,
        pocket,
    };
    assertGpuIntentConsistent(config.useGPU, settings.nGpuLayers);
    (0, optionValidation_1.validateEngineOptions)(setup);
    if (config.useGPU === undefined && settings.nGpuLayers == null) {
        config.useGPU = false;
    }
    return setup;
}
