"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPocketParams = buildPocketParams;
const bare_path_1 = __importDefault(require("bare-path"));
const DEFAULT_SAMPLING_STEPS = 1;
const UNSUPPORTED_OPTIONS = [
    'voice',
    'voiceName',
    'voiceDir',
    'speed',
    'noiseNpyPath',
    'kvCacheType',
    'streamChunkTokens',
    'streamFirstChunkTokens',
    'cfmSteps',
    'cfgRate',
    'streamLeftContextTokens',
    'promptText',
    'referenceText',
    'instruct',
    'description',
    'voiceDescription',
    'emotion',
    'pace',
    'pitch',
    'expressivity',
    'noise',
    'reverb',
    'quality',
    'greedy',
    'topK',
    'topP',
    'maxFrames',
    'minNewTokens',
    'normalizeNumbers',
    'enhancer',
    'denoiser'
];
const NUMERIC_OPTIONS = {
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
function resolveAsset(root, value, name) {
    return value || (root ? bare_path_1.default.join(root, name) : '');
}
function resolveModelFiles(files, options) {
    return {
        engineType: 'pocket',
        pocketFlowModelPath: resolveAsset(files.modelDir, files.pocketFlowModel, 'flow-lm.gguf'),
        pocketMimiModelPath: resolveAsset(files.modelDir, files.pocketMimiModel, 'mimi.gguf'),
        pocketFrontendPath: resolveAsset(files.modelDir, files.pocketFrontend, 'frontend.json'),
        pocketVoicePath: files.pocketVoice ||
            (options.referenceAudio ? '' : resolveAsset(files.modelDir, undefined, 'voice.gguf')),
        referenceAudio: typeof options.referenceAudio === 'string' ? options.referenceAudio : '',
        language: 'en',
        useGPU: false,
        steps: DEFAULT_SAMPLING_STEPS
    };
}
function validateEngineOptions(options, config) {
    if (options.referenceAudio !== undefined && typeof options.referenceAudio !== 'string')
        throw new Error('Pocket referenceAudio must be a path string');
    if (config.language !== undefined && config.language !== 'en')
        throw new Error('Pocket currently supports English (en) only');
    if (config.useGPU !== undefined && config.useGPU !== false)
        throw new Error('Pocket currently supports CPU only (useGPU: false)');
    if (options.nGpuLayers !== undefined && options.nGpuLayers !== 0)
        throw new Error('Pocket requires nGpuLayers: 0');
    if (options.steps !== undefined &&
        options.numInferenceSteps !== undefined &&
        options.steps !== options.numInferenceSteps)
        throw new Error('Pocket steps conflicts with numInferenceSteps');
}
function rejectUnsupportedOptions(options) {
    for (const key of UNSUPPORTED_OPTIONS) {
        if (options[key] !== undefined)
            throw new Error('Pocket does not support ' + key);
    }
}
function numericOptionValue(key, options, config) {
    if (key === 'outputSampleRate')
        return config.outputSampleRate;
    if (key === 'steps')
        return options.steps === undefined ? options.numInferenceSteps : options.steps;
    return options[key];
}
function validateNumericOption(key, value, min, max, integer) {
    if (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))) {
        throw new Error('Invalid Pocket ' +
            key +
            ': expected ' +
            (integer ? 'an integer' : 'a number') +
            ' between ' +
            min +
            ' and ' +
            max);
    }
    return value;
}
function applyNumericOptions(params, options, config) {
    for (const [key, [min, max, integer = true]] of Object.entries(NUMERIC_OPTIONS)) {
        const value = numericOptionValue(key, options, config);
        if (value !== undefined)
            params[key] = validateNumericOption(key, value, min, max, integer);
    }
}
function validateRequiredFiles(params) {
    for (const key of ['pocketFlowModelPath', 'pocketMimiModelPath', 'pocketFrontendPath']) {
        if (typeof params[key] !== 'string' || !params[key])
            throw new Error('Pocket requires ' + key);
    }
}
function validateVoiceConditioning(params) {
    if (typeof params.pocketVoicePath !== 'string' ||
        typeof params.referenceAudio !== 'string' ||
        !!params.pocketVoicePath === !!params.referenceAudio) {
        throw new Error('Pocket requires exactly one prepared voice file or referenceAudio WAV');
    }
}
function buildPocketParams(files, optionInput, configInput) {
    const options = optionInput;
    const config = configInput;
    validateEngineOptions(options, config);
    rejectUnsupportedOptions(options);
    const params = resolveModelFiles(files, options);
    applyNumericOptions(params, options, config);
    validateRequiredFiles(params);
    validateVoiceConditioning(params);
    return params;
}
