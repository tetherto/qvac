"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPocketParams = buildPocketParams;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare CommonJS module. */
const path = require("bare-path");
// Keep JS and native validation aligned. In particular, never bitwise-coerce
// the unsigned seed or accept non-finite/fractional numeric settings.
function buildPocketParams(files, optionInput, configInput) {
    const options = optionInput;
    const config = configInput;
    const root = files.modelDir;
    const asset = (value, name) => value || (root ? path.join(root, name) : '');
    const params = {
        engineType: 'pocket',
        pocketFlowModelPath: asset(files.pocketFlowModel, 'flow-lm.gguf'),
        pocketMimiModelPath: asset(files.pocketMimiModel, 'mimi.gguf'),
        pocketFrontendPath: asset(files.pocketFrontend, 'frontend.json'),
        pocketVoicePath: files.pocketVoice || (options.referenceAudio ? '' : asset(undefined, 'voice.gguf')),
        referenceAudio: typeof options.referenceAudio === 'string' ? options.referenceAudio : '',
        language: 'en',
        useGPU: false
    };
    if (options.referenceAudio !== undefined && typeof options.referenceAudio !== 'string')
        throw new Error('Pocket referenceAudio must be a path string');
    if (config.language !== undefined && config.language !== 'en')
        throw new Error('Pocket currently supports English (en) only');
    if (config.useGPU !== undefined && config.useGPU !== false)
        throw new Error('Pocket currently supports CPU only (useGPU: false)');
    if (options.nGpuLayers !== undefined && options.nGpuLayers !== 0)
        throw new Error('Pocket requires nGpuLayers: 0');
    for (const key of ['voice', 'voiceName', 'voiceDir', 'speed', 'noiseNpyPath', 'kvCacheType', 'streamChunkTokens', 'streamFirstChunkTokens', 'cfmSteps', 'cfgRate', 'streamLeftContextTokens', 'promptText', 'referenceText', 'instruct', 'description', 'voiceDescription', 'emotion', 'pace', 'pitch', 'expressivity', 'noise', 'reverb', 'quality', 'greedy', 'topK', 'topP', 'maxFrames', 'minNewTokens', 'normalizeNumbers', 'enhancer', 'denoiser']) {
        if (options[key] !== undefined)
            throw new Error('Pocket does not support ' + key);
    }
    if (options.steps !== undefined && options.numInferenceSteps !== undefined && options.steps !== options.numInferenceSteps) {
        throw new Error('Pocket steps conflicts with numInferenceSteps');
    }
    const specs = {
        threads: [1, 1024],
        nCtx: [1, 8192],
        maxTokens: [1, 1024],
        steps: [1, 64],
        framesAfterEos: [-1, 100],
        seed: [0, 4294967295],
        temperature: [0, 10, false],
        noiseClamp: [0, 3.402823466e38, false],
        eosThreshold: [-3.402823466e38, 3.402823466e38, false],
        outputSampleRate: [8000, 192000]
    };
    for (const [key, [min, max, integer = true]] of Object.entries(specs)) {
        const value = key === 'outputSampleRate'
            ? config.outputSampleRate
            : key === 'steps' ? (options.steps === undefined ? options.numInferenceSteps : options.steps) : options[key];
        if (value === undefined)
            continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
            throw new Error('Invalid Pocket ' + key + ': expected ' + (integer ? 'an integer' : 'a number') + ' between ' + min + ' and ' + max);
        }
        params[key] = value;
    }
    for (const key of ['pocketFlowModelPath', 'pocketMimiModelPath', 'pocketFrontendPath']) {
        if (typeof params[key] !== 'string' || !params[key])
            throw new Error('Pocket requires ' + key);
    }
    if (typeof params.pocketVoicePath !== 'string' || typeof params.referenceAudio !== 'string' ||
        !!params.pocketVoicePath === !!params.referenceAudio) {
        throw new Error('Pocket requires exactly one prepared voice file or referenceAudio WAV');
    }
    return params;
}
