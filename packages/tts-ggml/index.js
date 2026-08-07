"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const bareOs = require("bare-os");
const path = require("bare-path");
const fs = require("bare-fs");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const tts_1 = require("./tts");
const error_1 = require("./lib/error");
const textChunker_1 = require("./lib/textChunker");
const textStreamAccumulator_1 = require("./lib/textStreamAccumulator");
const { platform } = bareOs;
const ENGINE_CHATTERBOX = "chatterbox";
const ENGINE_SUPERTONIC = "supertonic";
// CosyVoice3 (Fun-CosyVoice3-0.5B / 1.5B). Ships as a small set of GGUFs
// (cosyvoice3-{llm,flow,hift}-*.gguf) plus voice.gguf, vocab.json and
// merges.txt; a modelDir holding them (or an explicit
// `files.cosyvoiceModelDir`) routes here.
const ENGINE_COSYVOICE3 = "cosyvoice3";
const ENGINE_PARLER = "parler";
const MIN_OUTPUT_SAMPLE_RATE = 8000;
const MAX_OUTPUT_SAMPLE_RATE = 192000;
const CHATTERBOX_T3_TURBO = "chatterbox-t3-turbo.gguf";
const CHATTERBOX_T3_MTL = "chatterbox-t3-mtl.gguf";
const CHATTERBOX_S3GEN_DEFAULT = "chatterbox-s3gen.gguf";
const CHATTERBOX_S3GEN_MTL = "chatterbox-s3gen-mtl.gguf";
const SUPERTONIC_DEFAULT = "supertonic.gguf";
const SUPERTONIC_MTL = "supertonic2.gguf";
const SUPERTONIC_V3_RE = /^supertonic3(-[a-z0-9_]+)?\.gguf$/i;
const SUPERTONIC_V3_QUANT_ORDER = [
    "f16",
    "f32",
    "q8_0",
    "q4_0",
];
// The LLM sub-model is the tell for CosyVoice3 modelDir auto-detection.
const COSYVOICE3_LLM_RE = /^cosyvoice3-llm(-[a-z0-9_]+)?\.gguf$/i;
// CosyVoice3 instruct2 control vocabulary (cosyvoice/utils/common.py
// instruct_list). The structured `instruct` option renders to the exact
// trained instruction string; the native engine wraps it as
// "You are a helpful assistant. " + <instruction> + "<|endofprompt|>" and
// drops the LM prompt speech tokens. One control applies per synthesis
// (the model is trained on single instructions).
const COSYVOICE_DIALECTS = {
    cantonese: "广东话",
    northeastern: "东北话",
    gansu: "甘肃话",
    guizhou: "贵州话",
    henan: "河南话",
    hubei: "湖北话",
    hunan: "湖南话",
    jiangxi: "江西话",
    minnan: "闽南话",
    ningxia: "宁夏话",
    shanxi: "山西话",
    shaanxi: "陕西话",
    shandong: "山东话",
    shanghai: "上海话",
    sichuan: "四川话",
    tianjin: "天津话",
    yunnan: "云南话",
};
const COSYVOICE_EMOTIONS = {
    happy: "请非常开心地说一句话。",
    sad: "请非常伤心地说一句话。",
    angry: "请非常生气地说一句话。",
};
const COSYVOICE_SPEEDS = {
    slow: "请用尽可能慢地语速说一句话。",
    fast: "请用尽可能快地语速说一句话。",
};
const COSYVOICE_VOLUMES = {
    loud: "Please say a sentence as loudly as possible.",
    soft: "Please say a sentence in a very soft voice.",
};
const COSYVOICE_STYLES = {
    peppa: "我想体验一下小猪佩奇风格，可以吗？",
    robot: "你可以尝试用机器人的方式解答吗？",
};
/**
 * Look up a structured-instruct control value, throwing a clear error for an
 * invalid key instead of letting an `undefined` render into the instruction
 * string.
 */
function cosyvoiceInstructValue(map, key, kind) {
    const value = map[key];
    if (value == null) {
        throw new Error(`Invalid CosyVoice instruct ${kind} "${key}". Valid ${kind}s: ${Object.keys(map).join(", ")}.`);
    }
    return value;
}
/**
 * Render a CosyVoice3 `instruct` option to the trained instruction string.
 * A raw string passes through (trimmed); the structured form emits exactly one
 * control by precedence dialect > emotion > speed > volume > style. Returns ""
 * for no instruction (zero-shot). An invalid structured key throws.
 */
function renderCosyvoiceInstruct(instruct) {
    if (instruct == null)
        return "";
    if (typeof instruct === "string")
        return instruct.trim();
    // Reject unknown structured keys (typos like `{ dialekt: 'cantonese' }`)
    // before the precedence chain, which would otherwise fall through to "".
    const supportedControls = ["dialect", "emotion", "speed", "volume", "style"];
    const unknownKeys = Object.keys(instruct).filter((key) => !supportedControls.includes(key));
    if (unknownKeys.length > 0) {
        throw new Error(`Invalid CosyVoice instruct key(s): ${unknownKeys.join(", ")}. ` +
            "Valid keys: dialect, emotion, speed, volume, style.");
    }
    if (instruct.dialect) {
        return `请用${cosyvoiceInstructValue(COSYVOICE_DIALECTS, instruct.dialect, "dialect")}表达。`;
    }
    if (instruct.emotion) {
        return cosyvoiceInstructValue(COSYVOICE_EMOTIONS, instruct.emotion, "emotion");
    }
    if (instruct.speed) {
        return cosyvoiceInstructValue(COSYVOICE_SPEEDS, instruct.speed, "speed");
    }
    if (instruct.volume) {
        return cosyvoiceInstructValue(COSYVOICE_VOLUMES, instruct.volume, "volume");
    }
    if (instruct.style) {
        return cosyvoiceInstructValue(COSYVOICE_STYLES, instruct.style, "style");
    }
    return "";
}
// Parler GGUFs ship per quant tier with the quant in the filename
// (`parler-mini-v1-q8_0.gguf`); a bare `parler.gguf` deliberately does not
// match, keeping ambiguous files out of the modelDir auto-detect path.
const PARLER_RE = /^parler-(mini|large|indic)(-v\d+)?(-[a-z0-9_]+)?\.gguf$/i;
const PARLER_VARIANT_ORDER = ["mini", "large", "indic"];
const PARLER_QUANT_ORDER = ["q8_0", "q6_k", "f16", "f32"];
const PARLER_DESCRIPTION_KEYS = ["description", "voiceDescription"];
const PARLER_TEMPLATE_KEYS = [
    "voice",
    "emotion",
    "pitch",
    "pace",
    "expressivity",
    "noise",
    "reverb",
    "quality",
];
const PARLER_FIELD_KEYS = [
    ...PARLER_DESCRIPTION_KEYS,
    ...PARLER_TEMPLATE_KEYS,
];
function normalizeError(error) {
    return typeof error === "string"
        ? error
        : error instanceof Error
            ? error
            : new Error("Unknown TTS error");
}
function firstNonEmpty(...candidates) {
    for (const value of candidates) {
        if (value != null && value !== "")
            return value;
    }
    return undefined;
}
function fileExistsSafe(filePath) {
    if (!filePath)
        return false;
    try {
        return fs.existsSync(filePath);
    }
    catch {
        return false;
    }
}
function findSupertonicV3InDir(modelDir) {
    if (!modelDir)
        return undefined;
    let entries;
    try {
        entries = fs.readdirSync(modelDir);
    }
    catch {
        return undefined;
    }
    const matches = entries.filter((name) => SUPERTONIC_V3_RE.test(name));
    if (matches.length === 0)
        return undefined;
    function rank(name) {
        if (/^supertonic3\.gguf$/i.test(name))
            return 0;
        const match = name.match(/^supertonic3-(.+)\.gguf$/i);
        const index = match
            ? SUPERTONIC_V3_QUANT_ORDER.indexOf(match[1].toLowerCase())
            : -1;
        return index === -1
            ? SUPERTONIC_V3_QUANT_ORDER.length + 1
            : index + 1;
    }
    matches.sort((left, right) => rank(left) - rank(right));
    return path.join(modelDir, matches[0]);
}
/**
 * True when `modelDir` contains a CosyVoice3 LLM GGUF (the sub-model that
 * unambiguously identifies a CosyVoice3 model directory).
 */
function dirHasCosyvoice3(modelDir) {
    if (!modelDir)
        return false;
    let entries;
    try {
        entries = fs.readdirSync(modelDir);
    }
    catch {
        return false;
    }
    return entries.some((name) => COSYVOICE3_LLM_RE.test(name));
}
/**
 * Find a Parler GGUF in `modelDir`, ranked by variant (mini before large
 * before indic) and, within a variant, by quant tier (q8_0 > q6_k > f16 > f32;
 * a bare `parler-<variant>.gguf` wins as forward-compat).
 */
function findParlerInDir(modelDir) {
    if (!modelDir)
        return undefined;
    let entries;
    try {
        entries = fs.readdirSync(modelDir);
    }
    catch {
        return undefined;
    }
    const matches = entries.filter((name) => PARLER_RE.test(name));
    if (matches.length === 0)
        return undefined;
    function rank(name) {
        const match = name.match(PARLER_RE);
        if (!match)
            return Number.MAX_SAFE_INTEGER;
        const variant = PARLER_VARIANT_ORDER.indexOf(match[1].toLowerCase());
        let quantRank = 0;
        if (match[3]) {
            const index = PARLER_QUANT_ORDER.indexOf(match[3].slice(1).toLowerCase());
            quantRank =
                index === -1 ? PARLER_QUANT_ORDER.length + 2 : index + 1;
        }
        return variant * 100 + quantRank;
    }
    matches.sort((left, right) => rank(left) - rank(right));
    return path.join(modelDir, matches[0]);
}
/**
 * Collect the Parler description/template properties present on `source`
 * (a run input, streaming options, or constructor options). Returns undefined
 * when none are set.
 */
function pickParlerDescFields(source) {
    if (source == null || typeof source !== "object")
        return undefined;
    const out = {};
    let any = false;
    for (const key of PARLER_FIELD_KEYS) {
        const value = source[key];
        if (value != null && value !== "") {
            out[key] = String(value);
            any = true;
        }
    }
    return any ? out : undefined;
}
/**
 * Same-level conflict check: a free-text description cannot be merged with
 * template fields, so setting both together is an error.
 */
function assertParlerDescFieldsConsistent(fields, where) {
    if (!fields)
        return;
    const hasDescription = PARLER_DESCRIPTION_KEYS.some((key) => fields[key] != null);
    const templateKeys = PARLER_TEMPLATE_KEYS.filter((key) => fields[key] != null);
    if (hasDescription && templateKeys.length > 0) {
        throw new Error(`tts-ggml: ${where}: 'description' is mutually exclusive with the ` +
            `voice-template options (got ${templateKeys.join(", ")})`);
    }
}
function normalizeGgmlFiles(files) {
    if (files == null || typeof files !== "object")
        return {};
    return {
        modelDir: firstNonEmpty(files.modelDir),
        t3Model: firstNonEmpty(files.t3Model, files.t3ModelPath, files.t3),
        s3genModel: firstNonEmpty(files.s3genModel, files.s3genModelPath, files.s3gen),
        supertonicModel: firstNonEmpty(files.supertonicModel, files.supertonicModelPath, files.supertonic),
        // CosyVoice3: either a dedicated modelDir of cosyvoice3-*.gguf files, or
        // explicit per-component paths. Falls back to the shared `modelDir`.
        cosyvoiceModelDir: firstNonEmpty(files.cosyvoiceModelDir),
        cosyvoiceLlmModel: firstNonEmpty(files.cosyvoiceLlmModel, files.cosyvoiceLlmModelPath),
        cosyvoiceFlowModel: firstNonEmpty(files.cosyvoiceFlowModel, files.cosyvoiceFlowModelPath),
        cosyvoiceHiftModel: firstNonEmpty(files.cosyvoiceHiftModel, files.cosyvoiceHiftModelPath),
        cosyvoiceS3tokModel: firstNonEmpty(files.cosyvoiceS3tokModel, files.cosyvoiceS3tokModelPath),
        cosyvoiceCampplusModel: firstNonEmpty(files.cosyvoiceCampplusModel, files.cosyvoiceCampplusModelPath),
        parlerModel: firstNonEmpty(files.parlerModel, files.parlerModelPath, files.parler),
        voicesDir: firstNonEmpty(files.voicesDir),
        lavasrEnhancer: firstNonEmpty(files.lavasrEnhancer),
        lavasrDenoiser: firstNonEmpty(files.lavasrDenoiser),
        mecabDictDir: firstNonEmpty(files.mecabDictDir, files.mecabDictPath),
        cangjieTsvPath: firstNonEmpty(files.cangjieTsvPath, files.cangjieTsv),
    };
}
function detectEngineType(engine, files) {
    if (engine === ENGINE_CHATTERBOX ||
        engine === ENGINE_SUPERTONIC ||
        engine === ENGINE_COSYVOICE3 ||
        engine === ENGINE_PARLER) {
        return engine;
    }
    if (engine != null && engine !== "") {
        throw new Error("tts-ggml: 'engine' option must be 'chatterbox', 'supertonic', " +
            `'cosyvoice3' or 'parler' (got '${String(engine)}')`);
    }
    // Explicit CosyVoice3 files/dir take precedence over shared-modelDir sniffing.
    if (files.cosyvoiceModelDir || files.cosyvoiceLlmModel) {
        return ENGINE_COSYVOICE3;
    }
    if (files.t3Model || files.s3genModel)
        return ENGINE_CHATTERBOX;
    if (files.supertonicModel)
        return ENGINE_SUPERTONIC;
    if (files.parlerModel)
        return ENGINE_PARLER;
    if (files.modelDir) {
        if (dirHasCosyvoice3(files.modelDir))
            return ENGINE_COSYVOICE3;
        const hasChatterbox = fileExistsSafe(path.join(files.modelDir, CHATTERBOX_T3_TURBO)) ||
            fileExistsSafe(path.join(files.modelDir, CHATTERBOX_T3_MTL));
        const hasSupertonic = fileExistsSafe(path.join(files.modelDir, SUPERTONIC_DEFAULT)) ||
            fileExistsSafe(path.join(files.modelDir, SUPERTONIC_MTL)) ||
            !!findSupertonicV3InDir(files.modelDir);
        if (hasChatterbox)
            return ENGINE_CHATTERBOX;
        if (hasSupertonic)
            return ENGINE_SUPERTONIC;
        if (findParlerInDir(files.modelDir))
            return ENGINE_PARLER;
    }
    return ENGINE_CHATTERBOX;
}
function resolveSupertonicModelDirPath(modelDir) {
    const english = path.join(modelDir, SUPERTONIC_DEFAULT);
    const multilingual = path.join(modelDir, SUPERTONIC_MTL);
    const versionThree = findSupertonicV3InDir(modelDir);
    if (fileExistsSafe(english))
        return english;
    if (fileExistsSafe(multilingual))
        return multilingual;
    if (versionThree)
        return versionThree;
    return english;
}
function resolveChatterboxModelDirPaths(modelDir) {
    const turboT3 = path.join(modelDir, CHATTERBOX_T3_TURBO);
    const multilingualT3 = path.join(modelDir, CHATTERBOX_T3_MTL);
    const defaultS3 = path.join(modelDir, CHATTERBOX_S3GEN_DEFAULT);
    const multilingualS3 = path.join(modelDir, CHATTERBOX_S3GEN_MTL);
    if (fileExistsSafe(multilingualT3) &&
        !fileExistsSafe(turboT3)) {
        return {
            t3: multilingualT3,
            s3: fileExistsSafe(multilingualS3)
                ? multilingualS3
                : defaultS3,
        };
    }
    return { t3: turboT3, s3: defaultS3 };
}
function defaultAccumulateSentencesForStreamInput(textStream) {
    if (textStream == null ||
        typeof textStream === "string" ||
        Array.isArray(textStream)) {
        return false;
    }
    return (typeof textStream[Symbol.asyncIterator] === "function");
}
function ttsOutputDebugString(data) {
    if (!data)
        return "";
    if (typeof data === "string")
        return data;
    if (typeof data === "number" ||
        typeof data === "boolean" ||
        typeof data === "bigint") {
        return data.toString();
    }
    if (typeof data === "symbol")
        return data.description || "";
    if (typeof data === "function")
        return data.name;
    const value = data;
    const summary = {};
    if (value.sampleRate != null)
        summary.sampleRate = value.sampleRate;
    if (value.chunkIndex != null)
        summary.chunkIndex = value.chunkIndex;
    if (value.isLast != null)
        summary.isLast = value.isLast;
    if (value.sentenceChunk != null) {
        summary.sentenceChunk = value.sentenceChunk;
    }
    if (value.outputArray &&
        typeof value.outputArray.length === "number") {
        summary.outputArrayLen = value.outputArray.length;
    }
    return JSON.stringify(summary);
}
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
    return firstNonEmpty(files.lavasrEnhancer, enhancer?.enhancerPath);
}
function resolveDenoiserGgufPath(files, denoiser) {
    if (denoiser != null && denoiser.type !== "lavasr") {
        throw new Error(`tts-ggml: unknown denoiser.type '${String(denoiser.type)}', expected 'lavasr'.`);
    }
    return firstNonEmpty(files.lavasrDenoiser, denoiser?.denoiserPath);
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
function isAudioOutputEvent(data) {
    return (data != null &&
        typeof data === "object" &&
        "outputArray" in data &&
        data.outputArray != null);
}
function isStatsEvent(data) {
    return (data != null &&
        typeof data === "object" &&
        ("totalTime" in data ||
            "audioDurationMs" in data ||
            "totalSamples" in data));
}
function computeSentenceStreamStats(chunks, accumulator) {
    const totalCharacters = chunks.join("").length;
    return {
        ...accumulator,
        tokensPerSecond: accumulator.totalTime > 0
            ? totalCharacters / accumulator.totalTime
            : 0,
        realTimeFactor: accumulator.audioDurationMs > 0
            ? (accumulator.totalTime * 1000) /
                accumulator.audioDurationMs
            : 0,
    };
}
/**
 * GGML-backed TTS via the `tts-cpp` library. Wraps both
 * `tts_cpp::chatterbox::Engine` and `tts_cpp::supertonic::Engine` behind a
 * single engine-agnostic JavaScript surface. Engine type is auto-detected
 * from `files` or selected explicitly with `engine`.
 *
 * Owns a persistent native engine: model weights and voice-conditioning
 * tensors are loaded once by `load()` and reused by `run()`, `runStream()`,
 * and `runStreaming()`.
 */
class TTSGgml {
    static inferenceManagerConfig = {
        noAdditionalDownload: true,
    };
    static ENGINE_CHATTERBOX = ENGINE_CHATTERBOX;
    static ENGINE_SUPERTONIC = ENGINE_SUPERTONIC;
    static ENGINE_COSYVOICE3 = ENGINE_COSYVOICE3;
    static ENGINE_PARLER = ENGINE_PARLER;
    opts;
    exclusiveRun;
    logger;
    state;
    addon;
    _job;
    _runExclusive;
    _ttsInferenceQueueWaiter;
    _sentenceStreamCtx;
    _config;
    _lazySessionLoading;
    _outputSampleRate;
    _engineType;
    _voicesDir;
    _supertonicModelPath;
    _t3ModelPath;
    _s3genModelPath;
    _cosyvoiceModelDir;
    _cosyvoiceLlmModelPath;
    _cosyvoiceFlowModelPath;
    _cosyvoiceHiftModelPath;
    _cosyvoiceS3tokModelPath;
    _cosyvoiceCampplusModelPath;
    _mecabDictPath;
    _cangjieTsvPath;
    _referenceAudio;
    _voiceDir;
    _seed;
    _nGpuLayers;
    _nCtx;
    _kvCacheType;
    _threads;
    _streamChunkTokens;
    _streamFirstChunkTokens;
    _streamLeftContextTokens;
    _cfmSteps;
    _cfgRate;
    _promptText;
    _instruct;
    _voice;
    _steps;
    _speed;
    _noiseNpyPath;
    _enhancerGgufPath;
    _denoiserGgufPath;
    _backendsDir;
    _openclCacheDir;
    _vulkanCacheDir;
    _parlerModelPath;
    _description;
    _emotion;
    _pitch;
    _pace;
    _expressivity;
    _noise;
    _reverb;
    _quality;
    _temperature;
    _topK;
    _topP;
    _maxFrames;
    _minNewTokens;
    _normalizeNumbers;
    constructor(options = {}) {
        this.opts = options.opts || {};
        this.exclusiveRun = !!options.exclusiveRun;
        this.logger = new QvacLogger(options.logger);
        this.state = {
            configLoaded: false,
            weightsLoaded: false,
            destroyed: false,
        };
        this.addon = null;
        this._sentenceStreamCtx = null;
        this._ttsInferenceQueueWaiter = Promise.resolve();
        this._job = (0, infer_base_1.createJobHandler)({
            cancel: () => this._optionalAddon()?.cancel(),
        });
        this._runExclusive = this.exclusiveRun
            ? (0, infer_base_1.exclusiveRunQueue)()
            : async function runNow(callback) {
                return callback();
            };
        const normalizedFiles = normalizeGgmlFiles(options.files || {});
        this._config = { ...(options.config || {}) };
        this._lazySessionLoading = resolveDefaultLazySessionLoading(options.lazySessionLoading);
        this._outputSampleRate = validateOutputSampleRate(this._config.outputSampleRate);
        this._engineType = detectEngineType(options.engine, normalizedFiles);
        this._resolveEngineAndModelPaths(normalizedFiles);
        this._mecabDictPath = firstNonEmpty(options.mecabDictPath, options.mecabDictDir, normalizedFiles.mecabDictDir);
        this._cangjieTsvPath = firstNonEmpty(options.cangjieTsvPath, normalizedFiles.cangjieTsvPath);
        this._assignSynthesisOptions(options);
        this._enhancerGgufPath = resolveEnhancerGgufPath(normalizedFiles, options.enhancer);
        this._denoiserGgufPath = resolveDenoiserGgufPath(normalizedFiles, options.denoiser);
        this._backendsDir = firstNonEmpty(options.backendsDir, this._config.backendsDir, path.join(__dirname, "prebuilds"));
        this._openclCacheDir = firstNonEmpty(options.openclCacheDir, this._config.openclCacheDir);
        this._vulkanCacheDir = firstNonEmpty(options.vulkanCacheDir, this._config.vulkanCacheDir);
        assertGpuIntentConsistent(this._config.useGPU, this._nGpuLayers);
        this._assertEngineStreamingSupport();
        if (this._config.useGPU === undefined &&
            this._nGpuLayers == null) {
            this._config.useGPU = false;
        }
    }
    _resolveEngineAndModelPaths(files) {
        this._voicesDir = files.voicesDir;
        if (this._engineType === ENGINE_COSYVOICE3) {
            // CosyVoice3 discovers its sub-model GGUFs from a model directory; the
            // native engine resolves the individual components. Explicit
            // per-component paths win over the directory.
            this._cosyvoiceModelDir = firstNonEmpty(files.cosyvoiceModelDir, files.modelDir);
            this._cosyvoiceLlmModelPath = files.cosyvoiceLlmModel;
            this._cosyvoiceFlowModelPath = files.cosyvoiceFlowModel;
            this._cosyvoiceHiftModelPath = files.cosyvoiceHiftModel;
            this._cosyvoiceS3tokModelPath = files.cosyvoiceS3tokModel;
            this._cosyvoiceCampplusModelPath = files.cosyvoiceCampplusModel;
            return;
        }
        if (this._engineType === ENGINE_SUPERTONIC) {
            this._supertonicModelPath = firstNonEmpty(files.supertonicModel, files.modelDir
                ? resolveSupertonicModelDirPath(files.modelDir)
                : undefined);
            return;
        }
        if (this._engineType === ENGINE_PARLER) {
            this._parlerModelPath = firstNonEmpty(files.parlerModel, files.modelDir ? findParlerInDir(files.modelDir) : undefined);
            return;
        }
        if (files.modelDir) {
            const resolved = resolveChatterboxModelDirPaths(files.modelDir);
            this._t3ModelPath = firstNonEmpty(files.t3Model, resolved.t3);
            this._s3genModelPath = firstNonEmpty(files.s3genModel, resolved.s3);
        }
        else {
            this._t3ModelPath = files.t3Model;
            this._s3genModelPath = files.s3genModel;
        }
    }
    _assignSynthesisOptions(options) {
        this._referenceAudio = options.referenceAudio;
        this._voiceDir = options.voiceDir;
        this._seed = options.seed;
        this._nGpuLayers = options.nGpuLayers;
        this._nCtx = options.nCtx;
        this._kvCacheType = options.kvCacheType;
        this._threads = options.threads;
        this._streamChunkTokens = options.streamChunkTokens;
        this._streamFirstChunkTokens = options.streamFirstChunkTokens;
        // CosyVoice3-only: left-context speech tokens carried into each streaming chunk.
        this._streamLeftContextTokens = options.streamLeftContextTokens;
        this._cfmSteps = options.cfmSteps;
        this._cfgRate = options.cfgRate;
        // CosyVoice3-only: transcript of the reference audio for zero-shot cloning.
        this._promptText = options.promptText;
        // CosyVoice3-only: render the structured/raw instruct2 control to its string.
        this._instruct = renderCosyvoiceInstruct(options.instruct) || undefined;
        this._voice = firstNonEmpty(options.voice, options.voiceName);
        this._steps = firstNonEmpty(options.steps, options.numInferenceSteps);
        this._speed = options.speed;
        this._noiseNpyPath = options.noiseNpyPath;
        // Parler voice-description surface (all optional; the all-defaults render
        // is the models' recommended fallback caption).
        this._description = firstNonEmpty(options.description, options.voiceDescription);
        this._emotion = options.emotion;
        this._pitch = options.pitch;
        this._pace = options.pace;
        this._expressivity = options.expressivity;
        this._noise = options.noise;
        this._reverb = options.reverb;
        this._quality = options.quality;
        this._temperature = options.temperature;
        this._topK = options.topK;
        this._topP = options.topP;
        this._maxFrames = options.maxFrames;
        this._minNewTokens = options.minNewTokens;
        this._normalizeNumbers = options.normalizeNumbers;
    }
    _assertEngineStreamingSupport() {
        if (this._engineType === ENGINE_SUPERTONIC &&
            (this._streamChunkTokens != null ||
                this._streamFirstChunkTokens != null)) {
            throw new Error("tts-ggml: streamChunkTokens / streamFirstChunkTokens are " +
                "Chatterbox-only options (sub-sentence native streaming via " +
                "the chatterbox::Engine streaming chunked S3Gen+HiFT loop). " +
                "Supertonic does not support sub-sentence native streaming; " +
                "use sentence-level streaming via the engine-agnostic " +
                "runStream() / runStreaming() / run({ streamOutput: true }) APIs.");
        }
        // Runs before the denoiser guard so a Parler description/template conflict
        // is reported ahead of the engine-agnostic streaming constraints.
        this._assertParlerOptionConsistency();
        this._assertCosyvoiceOptionConsistency();
        if (this._denoiserGgufPath && this._requestsChunkStreaming()) {
            throw new Error("tts-ggml: the LavaSR denoiser is not yet supported with " +
                "native chunk streaming (streamChunkTokens > 0). Use batch " +
                "synthesis, or drop the denoiser for streaming. Streaming " +
                "denoise is a planned follow-up (needs a stateful streaming " +
                "denoiser).");
        }
    }
    // Every streaming engine starts native chunk streaming on
    // streamChunkTokens > 0 alone: a count of 0 means batch, and
    // streamFirstChunkTokens only sizes the first chunk once streaming is on.
    _requestsChunkStreaming() {
        return (this._streamChunkTokens ?? 0) > 0;
    }
    _assertParlerOptionConsistency() {
        if (this._engineType === ENGINE_PARLER) {
            assertParlerDescFieldsConsistent(pickParlerDescFields({
                description: this._description,
                voice: this._voice,
                emotion: this._emotion,
                pitch: this._pitch,
                pace: this._pace,
                expressivity: this._expressivity,
                noise: this._noise,
                reverb: this._reverb,
                quality: this._quality,
            }), "constructor");
            return;
        }
        const parlerOnly = [];
        if (this._description != null) {
            parlerOnly.push("description/voiceDescription");
        }
        const parlerOnlyFields = {
            emotion: this._emotion,
            pitch: this._pitch,
            pace: this._pace,
            expressivity: this._expressivity,
            noise: this._noise,
            reverb: this._reverb,
            quality: this._quality,
            temperature: this._temperature,
            topK: this._topK,
            topP: this._topP,
            maxFrames: this._maxFrames,
            minNewTokens: this._minNewTokens,
            normalizeNumbers: this._normalizeNumbers,
        };
        for (const [key, value] of Object.entries(parlerOnlyFields)) {
            if (value != null)
                parlerOnly.push(key);
        }
        if (parlerOnly.length > 0) {
            throw new Error(`tts-ggml: ${parlerOnly.join(", ")} are parler-only options ` +
                `(engine is ${this._engineType})`);
        }
    }
    _assertCosyvoiceOptionConsistency() {
        if (this._engineType === ENGINE_COSYVOICE3)
            return;
        const cosyvoiceOnly = [];
        const cosyvoiceOnlyFields = {
            instruct: this._instruct,
            promptText: this._promptText,
            streamLeftContextTokens: this._streamLeftContextTokens,
        };
        for (const [key, value] of Object.entries(cosyvoiceOnlyFields)) {
            if (value != null)
                cosyvoiceOnly.push(key);
        }
        if (cosyvoiceOnly.length > 0) {
            throw new Error(`tts-ggml: ${cosyvoiceOnly.join(", ")} are cosyvoice3-only options ` +
                `(engine is ${this._engineType})`);
        }
    }
    /**
     * Extract + validate the per-call parler description/template fields from a
     * run input or streaming options. Returns undefined when none are present.
     * Parler-only; a per-call template cannot be merged with a constructor-level
     * free-text description.
     */
    _resolveParlerJobFields(source, where) {
        const fields = pickParlerDescFields(source);
        if (!fields)
            return undefined;
        if (this._engineType !== ENGINE_PARLER) {
            throw new Error(`tts-ggml: ${where}: per-call description/voice-template options ` +
                `are parler-only (engine is ${this._engineType})`);
        }
        assertParlerDescFieldsConsistent(fields, where);
        const hasDescription = PARLER_DESCRIPTION_KEYS.some((key) => fields[key] != null);
        if (!hasDescription && this._description != null) {
            throw new Error(`tts-ggml: ${where}: per-call template options cannot be combined ` +
                "with a constructor-level description; pass a per-call " +
                "description instead");
        }
        return fields;
    }
    getEngineType() {
        return this._engineType;
    }
    getApiDefinition() {
        const api = (0, infer_base_1.getApiDefinition)();
        this._getLogger().debug(`Using API definition: ${api} for platform: ${platform()}`);
        return api;
    }
    getState() {
        return this.state;
    }
    async load(..._args) {
        void _args;
        if (this.state.destroyed) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_LOAD,
                adds: "instance was destroyed",
            });
        }
        if (this.state.configLoaded || this.state.weightsLoaded) {
            this._getLogger().info("Reload requested - unloading existing model first");
            await this.unload();
        }
        await this._load();
        this.state.configLoaded = true;
        this.state.weightsLoaded = true;
    }
    async run(input) {
        if (input?.streamOutput === true) {
            if (typeof input.input !== "string" ||
                input.input.trim().length === 0) {
                throw new error_1.QvacErrorAddonTTSGgml({
                    code: error_1.ERR_CODES.FAILED_TO_APPEND,
                    adds: "run with streamOutput: non-empty string `input` is required",
                });
            }
            const parlerFields = this._resolveParlerJobFields(input, "run");
            const runStream = () => this._runStreamOrchestrator(input.input, {
                locale: input.locale,
                maxChunkScalars: input.maxChunkScalars,
            }, parlerFields);
            return this.exclusiveRun
                ? this._enqueueExclusiveTtsResponse(runStream)
                : runStream();
        }
        return this._runExclusive(() => this._runInternal(input));
    }
    /**
     * Chunked streaming synthesis. Equivalent to
     * `run({ input: text, streamOutput: true, ...options })`.
     */
    async runStream(text, options = {}) {
        const normalized = options == null || typeof options !== "object" ? {} : options;
        return this.run({
            input: text,
            streamOutput: true,
            locale: normalized.locale,
            maxChunkScalars: normalized.maxChunkScalars,
            ...(pickParlerDescFields(normalized) ?? {}),
        });
    }
    /**
     * Streaming text in and streaming audio out. Each flushed string is one
     * native job and emits PCM through `response.onUpdate`.
     *
     * For `AsyncIterable` inputs, `accumulateSentences` defaults to `true` so
     * small streamed fragments are coalesced.
     */
    async runStreaming(textStream, options = {}) {
        const parlerFields = this._resolveParlerJobFields(options, "runStreaming");
        const streamOptions = this._resolveRunStreamingOptions(textStream, options);
        let normalized = this._normalizeTextStream(textStream);
        if (streamOptions.accumulateSentences) {
            normalized = (0, textStreamAccumulator_1.accumulateTextStream)(normalized, {
                sentenceDelimiterPreset: streamOptions.sentenceDelimiterPreset,
                maxBufferScalars: streamOptions.maxBufferScalars,
                flushAfterMs: streamOptions.flushAfterMs,
                sentenceDelimiter: streamOptions.sentenceDelimiter,
                language: this._config.language,
            });
        }
        const runStream = () => this._runTextStreamOrchestrator(normalized, parlerFields);
        return this.exclusiveRun
            ? this._enqueueExclusiveTtsResponse(runStream)
            : runStream();
    }
    async _enqueueExclusiveTtsResponse(run) {
        const previous = this._ttsInferenceQueueWaiter;
        let releaseSlot = () => { };
        this._ttsInferenceQueueWaiter = new Promise((resolve) => {
            releaseSlot = resolve;
        });
        await previous;
        let response;
        try {
            response = run();
        }
        catch (error) {
            releaseSlot();
            throw error;
        }
        void response
            .await()
            .finally(releaseSlot)
            .catch(() => { });
        return response;
    }
    _resolveRunStreamingOptions(textStream, options) {
        const normalized = options == null || typeof options !== "object" ? {} : options;
        let accumulateSentences = normalized.accumulateSentences;
        if (accumulateSentences === undefined) {
            accumulateSentences =
                defaultAccumulateSentencesForStreamInput(textStream);
        }
        return {
            accumulateSentences: !!accumulateSentences,
            sentenceDelimiterPreset: normalized.sentenceDelimiterPreset === "latin" ||
                normalized.sentenceDelimiterPreset === "cjk" ||
                normalized.sentenceDelimiterPreset === "multilingual"
                ? normalized.sentenceDelimiterPreset
                : "multilingual",
            maxBufferScalars: normalized.maxBufferScalars,
            flushAfterMs: normalized.flushAfterMs ?? textStreamAccumulator_1.DEFAULT_FLUSH_AFTER_MS,
            sentenceDelimiter: normalized.sentenceDelimiter instanceof RegExp
                ? normalized.sentenceDelimiter
                : undefined,
        };
    }
    _normalizeTextStream(textStream) {
        if (textStream == null) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_APPEND,
                adds: "runStreaming: text stream is required",
            });
        }
        if (typeof textStream === "string") {
            // eslint-disable-next-line @typescript-eslint/require-await -- async iterable shape is required by the public API.
            return (async function* oneString() {
                yield textStream;
            })();
        }
        if (typeof textStream[Symbol.asyncIterator] === "function") {
            return textStream;
        }
        if (Array.isArray(textStream) ||
            typeof textStream[Symbol.iterator] === "function") {
            // eslint-disable-next-line @typescript-eslint/require-await -- adapts synchronous iterables to the async iterable contract.
            return (async function* fromIterable() {
                for (const value of textStream) {
                    yield value;
                }
            })();
        }
        throw new error_1.QvacErrorAddonTTSGgml({
            code: error_1.ERR_CODES.FAILED_TO_APPEND,
            adds: "runStreaming: expected string, array of strings, Iterable, or AsyncIterable",
        });
    }
    _runTextStreamOrchestrator(source, parlerFields) {
        const response = this._job.start();
        this._sentenceStreamCtx = {
            textStreamMode: true,
            asyncTextSource: source,
            chunks: [],
            chunkIdx: 0,
            acc: { totalTime: 0, audioDurationMs: 0, totalSamples: 0 },
            chunkResolver: null,
            parlerFields,
        };
        void this._sentenceStreamTextIterableDrive().catch((error) => {
            this._rejectActiveChunk(error);
            this._sentenceStreamCtx = null;
            this._job.fail(normalizeError(error));
        });
        return response;
    }
    async _sentenceStreamTextIterableDrive() {
        const context = this._sentenceStreamCtx;
        if (!context ||
            !context.textStreamMode ||
            !context.asyncTextSource) {
            return;
        }
        try {
            for await (const piece of context.asyncTextSource) {
                const text = String(piece).trim();
                if (text.length === 0)
                    continue;
                context.chunks.push(text);
                context.chunkIdx = context.chunks.length - 1;
                const done = new Promise((resolve, reject) => {
                    context.chunkResolver = { resolve, reject };
                });
                await this._requireAddon().runJob({
                    type: "text",
                    input: text,
                    ...(context.parlerFields ?? {}),
                });
                await done;
            }
        }
        catch (error) {
            this._rejectActiveChunk(error);
            this._sentenceStreamCtx = null;
            this._job.fail(normalizeError(error));
            return;
        }
        const current = this._sentenceStreamCtx;
        const chunks = current?.chunks || [];
        const accumulator = current?.acc || {
            totalTime: 0,
            audioDurationMs: 0,
            totalSamples: 0,
        };
        this._sentenceStreamCtx = null;
        this._endJobWithStats(chunks.length === 0
            ? {
                totalTime: 0,
                tokensPerSecond: 0,
                realTimeFactor: 0,
                audioDurationMs: 0,
                totalSamples: 0,
            }
            : computeSentenceStreamStats(chunks, accumulator));
    }
    _runStreamOrchestrator(text, options, parlerFields) {
        const chunks = (0, textChunker_1.splitTtsText)(String(text), {
            language: this._config.language,
            locale: options.locale,
            maxScalars: options.maxChunkScalars,
        });
        if (chunks.length === 0) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_APPEND,
                adds: "chunked synthesis: text produced no chunks after split",
            });
        }
        const response = this._job.start();
        this._sentenceStreamCtx = {
            chunks,
            chunkIdx: 0,
            acc: { totalTime: 0, audioDurationMs: 0, totalSamples: 0 },
            chunkResolver: null,
            parlerFields,
        };
        void this._sentenceStreamDriveBody().catch((error) => {
            this._rejectActiveChunk(error);
            this._sentenceStreamCtx = null;
            this._job.fail(normalizeError(error));
        });
        return response;
    }
    async _sentenceStreamDriveBody() {
        const context = this._sentenceStreamCtx;
        if (!context || context.textStreamMode)
            return;
        for (let index = 0; index < context.chunks.length; index++) {
            context.chunkIdx = index;
            const done = new Promise((resolve, reject) => {
                context.chunkResolver = { resolve, reject };
            });
            await this._requireAddon().runJob({
                type: "text",
                input: context.chunks[index],
                ...(context.parlerFields ?? {}),
            });
            await done;
        }
        this._sentenceStreamCtx = null;
    }
    async _load() {
        this._getLogger().info("[TTSGgml] Language:", this._config.language || "en");
        const addon = this._createAddon(this._buildTtsParams(), this._addonOutputCallback.bind(this));
        this.addon = addon;
        try {
            await addon.activate();
        }
        catch (error) {
            try {
                await addon.destroyInstance();
            }
            catch { }
            if (this.addon === addon)
                this.addon = null;
            throw error;
        }
    }
    _buildTtsParams() {
        if (this._engineType === ENGINE_SUPERTONIC) {
            return this._buildSupertonicParams();
        }
        if (this._engineType === ENGINE_COSYVOICE3) {
            return this._buildCosyvoiceParams();
        }
        if (this._engineType === ENGINE_PARLER) {
            return this._buildParlerParams();
        }
        return this._buildChatterboxParams();
    }
    _buildCosyvoiceParams() {
        const parameters = {
            engineType: ENGINE_COSYVOICE3,
            cosyvoiceModelDir: this._cosyvoiceModelDir || "",
            language: this._config.language || "en",
        };
        if (this._cosyvoiceLlmModelPath) {
            parameters.cosyvoiceLlmModelPath = this._cosyvoiceLlmModelPath;
        }
        if (this._cosyvoiceFlowModelPath) {
            parameters.cosyvoiceFlowModelPath = this._cosyvoiceFlowModelPath;
        }
        if (this._cosyvoiceHiftModelPath) {
            parameters.cosyvoiceHiftModelPath = this._cosyvoiceHiftModelPath;
        }
        if (this._cosyvoiceS3tokModelPath) {
            parameters.cosyvoiceS3tokModelPath = this._cosyvoiceS3tokModelPath;
        }
        if (this._cosyvoiceCampplusModelPath) {
            parameters.cosyvoiceCampplusModelPath = this._cosyvoiceCampplusModelPath;
        }
        if (this._referenceAudio != null) {
            parameters.referenceAudio = this._referenceAudio;
        }
        if (this._promptText != null) {
            parameters.promptText = String(this._promptText);
        }
        if (this._instruct)
            parameters.instruct = this._instruct;
        if (this._voice)
            parameters.voice = this._voice;
        this._assignCommonNativeParams(parameters);
        if (this._cfmSteps != null)
            parameters.cfmSteps = this._cfmSteps | 0;
        if (this._streamChunkTokens != null) {
            parameters.streamChunkTokens = this._streamChunkTokens | 0;
        }
        if (this._streamFirstChunkTokens != null) {
            parameters.streamFirstChunkTokens = this._streamFirstChunkTokens | 0;
        }
        if (this._streamLeftContextTokens != null) {
            parameters.streamLeftContextTokens = this._streamLeftContextTokens | 0;
        }
        return parameters;
    }
    _buildChatterboxParams() {
        const parameters = {
            engineType: ENGINE_CHATTERBOX,
            t3ModelPath: this._t3ModelPath || "",
            s3genModelPath: this._s3genModelPath || "",
            language: this._config.language || "en",
        };
        this._assignCommonNativeParams(parameters);
        if (this._referenceAudio != null) {
            parameters.referenceAudio = this._referenceAudio;
        }
        if (this._voiceDir != null)
            parameters.voiceDir = this._voiceDir;
        if (this._nCtx != null)
            parameters.nCtx = this._nCtx | 0;
        if (this._kvCacheType != null) {
            parameters.kvCacheType = String(this._kvCacheType);
        }
        if (this._streamChunkTokens != null) {
            parameters.streamChunkTokens = this._streamChunkTokens | 0;
        }
        if (this._streamFirstChunkTokens != null) {
            parameters.streamFirstChunkTokens =
                this._streamFirstChunkTokens | 0;
        }
        if (this._cfmSteps != null) {
            parameters.cfmSteps = this._cfmSteps | 0;
        }
        if (this._cfgRate != null) {
            parameters.cfgRate = Number(this._cfgRate);
        }
        if (this._speed != null)
            parameters.speed = Number(this._speed);
        if (this._mecabDictPath) {
            parameters.mecabDictPath = this._mecabDictPath;
        }
        if (this._cangjieTsvPath) {
            parameters.cangjieTsvPath = this._cangjieTsvPath;
        }
        return parameters;
    }
    _buildSupertonicParams() {
        const parameters = {
            engineType: ENGINE_SUPERTONIC,
            supertonicModelPath: this._supertonicModelPath || "",
            language: this._config.language || "en",
        };
        this._assignCommonNativeParams(parameters);
        if (this._voice)
            parameters.voice = this._voice;
        if (this._steps != null)
            parameters.steps = this._steps | 0;
        if (this._speed != null)
            parameters.speed = Number(this._speed);
        if (this._noiseNpyPath) {
            parameters.noiseNpyPath = this._noiseNpyPath;
        }
        if (this._vulkanCacheDir) {
            parameters.vulkanCacheDir = this._vulkanCacheDir;
        }
        return parameters;
    }
    _buildParlerParams() {
        // Re-checked here (not only in the constructor) so reload({...}) cannot
        // smuggle in a description/template conflict.
        if (this._description != null) {
            const templateSet = [
                this._voice,
                this._emotion,
                this._pitch,
                this._pace,
                this._expressivity,
                this._noise,
                this._reverb,
                this._quality,
            ].some((value) => value != null && value !== "");
            if (templateSet) {
                throw new Error("tts-ggml: 'description' is mutually exclusive with the " +
                    "voice-template options");
            }
        }
        const parameters = {
            engineType: ENGINE_PARLER,
            parlerModelPath: this._parlerModelPath || "",
        };
        if (this._description != null) {
            parameters.description = String(this._description);
        }
        if (this._voice)
            parameters.voice = String(this._voice);
        if (this._emotion != null) {
            parameters.emotion = String(this._emotion);
        }
        if (this._pitch != null)
            parameters.pitch = String(this._pitch);
        if (this._pace != null)
            parameters.pace = String(this._pace);
        if (this._expressivity != null) {
            parameters.expressivity = String(this._expressivity);
        }
        if (this._noise != null)
            parameters.noise = String(this._noise);
        if (this._reverb != null)
            parameters.reverb = String(this._reverb);
        if (this._quality != null) {
            parameters.quality = String(this._quality);
        }
        if (this._seed != null)
            parameters.seed = this._seed | 0;
        if (this._threads != null)
            parameters.threads = this._threads | 0;
        if (this._temperature != null) {
            parameters.temperature = Number(this._temperature);
        }
        if (this._topK != null)
            parameters.topK = this._topK | 0;
        if (this._topP != null)
            parameters.topP = Number(this._topP);
        if (this._maxFrames != null) {
            parameters.maxFrames = this._maxFrames | 0;
        }
        if (this._minNewTokens != null) {
            parameters.minNewTokens = this._minNewTokens | 0;
        }
        if (this._streamChunkTokens != null) {
            parameters.streamChunkTokens = this._streamChunkTokens | 0;
        }
        if (this._streamFirstChunkTokens != null) {
            parameters.streamFirstChunkTokens =
                this._streamFirstChunkTokens | 0;
        }
        if (this._outputSampleRate != null) {
            parameters.outputSampleRate = this._outputSampleRate | 0;
        }
        if (this._normalizeNumbers != null) {
            parameters.normalizeNumbers = !!this._normalizeNumbers;
        }
        if (this._nGpuLayers != null) {
            parameters.nGpuLayers = this._nGpuLayers | 0;
        }
        if (this._config.useGPU != null) {
            parameters.useGPU = !!this._config.useGPU;
        }
        this._assignLavasrParams(parameters);
        if (this._backendsDir) {
            parameters.backendsDir = this._backendsDir;
        }
        return parameters;
    }
    _assignCommonNativeParams(parameters) {
        if (this._seed != null)
            parameters.seed = this._seed | 0;
        if (this._threads != null)
            parameters.threads = this._threads | 0;
        if (this._nGpuLayers != null) {
            parameters.nGpuLayers = this._nGpuLayers | 0;
        }
        if (this._outputSampleRate != null) {
            parameters.outputSampleRate = this._outputSampleRate | 0;
        }
        if (this._config.useGPU != null) {
            parameters.useGPU = !!this._config.useGPU;
        }
        this._assignLavasrParams(parameters);
        if (this._backendsDir) {
            parameters.backendsDir = this._backendsDir;
        }
        if (this._openclCacheDir) {
            parameters.openclCacheDir = this._openclCacheDir;
        }
    }
    /** LavaSR post-processing paths, shared by every engine that supports them. */
    _assignLavasrParams(parameters) {
        if (this._enhancerGgufPath) {
            parameters.lavasrEnhancerPath = this._enhancerGgufPath;
        }
        if (this._denoiserGgufPath) {
            parameters.lavasrDenoiserPath = this._denoiserGgufPath;
        }
    }
    _createAddon(configuration, outputCallback) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        return new tts_1.TTSInterface(binding, configuration, outputCallback);
    }
    async unload() {
        await this.cancel();
        this._failAndClearActiveResponse("Model was unloaded");
        const addon = this._optionalAddon();
        if (addon)
            await addon.destroyInstance();
        this.state.configLoaded = false;
        this.state.weightsLoaded = false;
    }
    async destroy() {
        await this.unload();
        this.state.destroyed = true;
    }
    async _runInternal(input) {
        const parlerFields = this._resolveParlerJobFields(input, "run");
        const response = this._job.start({
            signal: input?.signal,
        });
        if (input?.signal?.aborted)
            return response;
        try {
            await this._requireAddon().runJob({
                type: input.type || "text",
                input: input.input,
                ...(parlerFields ?? {}),
            });
        }
        catch (error) {
            this._job.fail(normalizeError(error));
            throw error;
        }
        return response;
    }
    _mergeSentenceStreamStats(accumulator, data) {
        accumulator.totalTime +=
            typeof data.totalTime === "number" ? data.totalTime : 0;
        accumulator.audioDurationMs +=
            typeof data.audioDurationMs === "number"
                ? data.audioDurationMs
                : 0;
        accumulator.totalSamples +=
            typeof data.totalSamples === "number" ? data.totalSamples : 0;
    }
    _rejectActiveChunk(error) {
        const resolver = this._sentenceStreamCtx?.chunkResolver;
        if (!resolver)
            return;
        this._sentenceStreamCtx.chunkResolver = null;
        resolver.reject(error);
    }
    _endJobWithStats(stats) {
        if (this.opts.stats)
            this._job.end(stats);
        else
            this._job.end();
    }
    _addonOutputCallback(_addon, event, data, error) {
        if (typeof error === "string" && error.length > 0) {
            this._handleAddonError(error);
        }
        else if (isAudioOutputEvent(data)) {
            this._handleAddonOutput(data);
        }
        else if (isStatsEvent(data)) {
            this._handleAddonStats(data);
        }
        else {
            this._getLogger().debug(`Received TTS event: ${String(event)}`);
        }
    }
    _handleAddonError(error) {
        this._getLogger().error(`TTS job failed with error: ${error}`);
        this._rejectActiveChunk(new Error(error));
        this._job.fail(error);
    }
    _handleAddonOutput(data) {
        try {
            this._getLogger().debug(`TTS job produced output: ${ttsOutputDebugString(data)}`);
        }
        catch (error) {
            if (error instanceof RangeError) {
                this._getLogger().debug("TTS job produced output: [data too large]");
            }
            else {
                throw error;
            }
        }
        this._job.output(this._sentenceStreamCtx
            ? this._enrichStreamChunk(data)
            : data);
    }
    _enrichStreamChunk(data) {
        const context = this._sentenceStreamCtx;
        if (!context) {
            // Preserve the historical ArrayBuffer declaration without changing the
            // native Int16Array payload or allocating a compatibility copy.
            return data;
        }
        const index = context.chunkIdx;
        const enriched = {
            // Public declarations historically expose ArrayBuffer; native output is
            // the more precise Int16Array representation at runtime.
            outputArray: data.outputArray,
            chunkIndex: index,
            sentenceChunk: context.chunks[index] || "",
        };
        if (data.sampleRate != null) {
            enriched.sampleRate = data.sampleRate;
        }
        if (!context.textStreamMode) {
            enriched.isLast = index >= context.chunks.length - 1;
        }
        return enriched;
    }
    _handleAddonStats(data) {
        this._getLogger().info(`TTS job completed. Stats: ${JSON.stringify(data)}`);
        const context = this._sentenceStreamCtx;
        if (!context) {
            this._endJobWithStats(data);
            return;
        }
        this._mergeSentenceStreamStats(context.acc, data);
        if (context.chunkResolver) {
            context.chunkResolver.resolve();
            context.chunkResolver = null;
        }
        if (!context.textStreamMode &&
            context.chunkIdx >= context.chunks.length - 1) {
            this._endJobWithStats(computeSentenceStreamStats(context.chunks, context.acc));
        }
    }
    async cancel() {
        const addon = this._optionalAddon();
        if (addon?.cancel)
            await addon.cancel();
    }
    _failAndClearActiveResponse(reason) {
        this._rejectActiveChunk(reason instanceof Error ? reason : new Error(reason));
        this._sentenceStreamCtx = null;
        this._job.fail(reason);
    }
    async reload(newConfig = {}) {
        this._getLogger().debug("Reloading addon with new configuration", newConfig);
        const runtimeConfig = newConfig;
        if (runtimeConfig.language !== undefined) {
            this._config.language = runtimeConfig.language;
        }
        if (runtimeConfig.useGPU !== undefined) {
            this._config.useGPU = runtimeConfig.useGPU;
        }
        if (runtimeConfig.outputSampleRate !== undefined) {
            this._outputSampleRate = runtimeConfig.outputSampleRate;
        }
        // Parler description/template + sampling knobs are reloadable; they rebuild
        // the engine's default description / sampler. _buildParlerParams re-validates
        // so a wrong-engine reload still throws.
        if (this._engineType === ENGINE_PARLER) {
            const parlerConfig = newConfig;
            if (parlerConfig.description !== undefined ||
                parlerConfig.voiceDescription !== undefined) {
                this._description = firstNonEmpty(parlerConfig.description, parlerConfig.voiceDescription);
            }
            if (parlerConfig.voice !== undefined) {
                this._voice = parlerConfig.voice;
            }
            if (parlerConfig.emotion !== undefined) {
                this._emotion = parlerConfig.emotion;
            }
            if (parlerConfig.pitch !== undefined) {
                this._pitch = parlerConfig.pitch;
            }
            if (parlerConfig.pace !== undefined) {
                this._pace = parlerConfig.pace;
            }
            if (parlerConfig.expressivity !== undefined) {
                this._expressivity = parlerConfig.expressivity;
            }
            if (parlerConfig.noise !== undefined) {
                this._noise = parlerConfig.noise;
            }
            if (parlerConfig.reverb !== undefined) {
                this._reverb = parlerConfig.reverb;
            }
            if (parlerConfig.quality !== undefined) {
                this._quality = parlerConfig.quality;
            }
            if (parlerConfig.temperature !== undefined) {
                this._temperature = parlerConfig.temperature;
            }
            if (parlerConfig.topK !== undefined) {
                this._topK = parlerConfig.topK;
            }
            if (parlerConfig.topP !== undefined) {
                this._topP = parlerConfig.topP;
            }
            if (parlerConfig.maxFrames !== undefined) {
                this._maxFrames = parlerConfig.maxFrames;
            }
            if (parlerConfig.minNewTokens !== undefined) {
                this._minNewTokens = parlerConfig.minNewTokens;
            }
            if (parlerConfig.normalizeNumbers !== undefined) {
                this._normalizeNumbers = parlerConfig.normalizeNumbers;
            }
            if (parlerConfig.seed !== undefined) {
                this._seed = parlerConfig.seed;
            }
        }
        const parameters = this._buildTtsParams();
        await this.cancel();
        this._failAndClearActiveResponse("Model was reloaded");
        const existingAddon = this._optionalAddon();
        if (existingAddon)
            await existingAddon.destroyInstance();
        this.addon = this._createAddon(parameters, this._addonOutputCallback.bind(this));
        await this._requireAddon().activate();
    }
    static getModelKey(_params) {
        void _params;
        return "tts-ggml";
    }
    _requireAddon() {
        const addon = this._optionalAddon();
        if (!addon)
            throw new Error("TTS addon is not loaded");
        return addon;
    }
    _optionalAddon() {
        return this.addon || null;
    }
    _getLogger() {
        return this.logger;
    }
}
module.exports = TTSGgml;
