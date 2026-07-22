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
function normalizeGgmlFiles(files) {
    if (files == null || typeof files !== "object")
        return {};
    return {
        modelDir: firstNonEmpty(files.modelDir),
        t3Model: firstNonEmpty(files.t3Model, files.t3ModelPath, files.t3),
        s3genModel: firstNonEmpty(files.s3genModel, files.s3genModelPath, files.s3gen),
        supertonicModel: firstNonEmpty(files.supertonicModel, files.supertonicModelPath, files.supertonic),
        voicesDir: firstNonEmpty(files.voicesDir),
        lavasrEnhancer: firstNonEmpty(files.lavasrEnhancer),
        lavasrDenoiser: firstNonEmpty(files.lavasrDenoiser),
        mecabDictDir: firstNonEmpty(files.mecabDictDir, files.mecabDictPath),
        cangjieTsvPath: firstNonEmpty(files.cangjieTsvPath, files.cangjieTsv),
    };
}
function detectEngineType(engine, files) {
    if (engine === ENGINE_CHATTERBOX || engine === ENGINE_SUPERTONIC) {
        return engine;
    }
    if (engine != null && engine !== "") {
        throw new Error("tts-ggml: 'engine' option must be 'chatterbox' or 'supertonic' " +
            `(got '${String(engine)}')`);
    }
    if (files.t3Model || files.s3genModel)
        return ENGINE_CHATTERBOX;
    if (files.supertonicModel)
        return ENGINE_SUPERTONIC;
    if (files.modelDir) {
        const hasChatterbox = fileExistsSafe(path.join(files.modelDir, CHATTERBOX_T3_TURBO)) ||
            fileExistsSafe(path.join(files.modelDir, CHATTERBOX_T3_MTL));
        const hasSupertonic = fileExistsSafe(path.join(files.modelDir, SUPERTONIC_DEFAULT)) ||
            fileExistsSafe(path.join(files.modelDir, SUPERTONIC_MTL)) ||
            !!findSupertonicV3InDir(files.modelDir);
        if (hasChatterbox)
            return ENGINE_CHATTERBOX;
        if (hasSupertonic)
            return ENGINE_SUPERTONIC;
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
    _cfmSteps;
    _cfgRate;
    _voice;
    _steps;
    _speed;
    _noiseNpyPath;
    _enhancerGgufPath;
    _denoiserGgufPath;
    _backendsDir;
    _openclCacheDir;
    _vulkanCacheDir;
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
        if (this._engineType === ENGINE_SUPERTONIC) {
            this._supertonicModelPath = firstNonEmpty(files.supertonicModel, files.modelDir
                ? resolveSupertonicModelDirPath(files.modelDir)
                : undefined);
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
        this._cfmSteps = options.cfmSteps;
        this._cfgRate = options.cfgRate;
        this._voice = firstNonEmpty(options.voice, options.voiceName);
        this._steps = firstNonEmpty(options.steps, options.numInferenceSteps);
        this._speed = options.speed;
        this._noiseNpyPath = options.noiseNpyPath;
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
        if (this._denoiserGgufPath &&
            (this._streamChunkTokens != null ||
                this._streamFirstChunkTokens != null)) {
            throw new Error("tts-ggml: the LavaSR denoiser is not yet supported with " +
                "Chatterbox native chunk streaming (streamChunkTokens / " +
                "streamFirstChunkTokens). Use batch synthesis, or drop the " +
                "denoiser for streaming. Streaming denoise is a planned " +
                "follow-up (needs a stateful streaming denoiser).");
        }
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
            const runStream = () => this._runStreamOrchestrator(input.input, {
                locale: input.locale,
                maxChunkScalars: input.maxChunkScalars,
            });
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
        const runStream = () => this._runTextStreamOrchestrator(normalized);
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
    _runTextStreamOrchestrator(source) {
        const response = this._job.start();
        this._sentenceStreamCtx = {
            textStreamMode: true,
            asyncTextSource: source,
            chunks: [],
            chunkIdx: 0,
            acc: { totalTime: 0, audioDurationMs: 0, totalSamples: 0 },
            chunkResolver: null,
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
    _runStreamOrchestrator(text, options) {
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
        return this._engineType === ENGINE_SUPERTONIC
            ? this._buildSupertonicParams()
            : this._buildChatterboxParams();
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
        if (this._enhancerGgufPath) {
            parameters.lavasrEnhancerPath = this._enhancerGgufPath;
        }
        if (this._denoiserGgufPath) {
            parameters.lavasrDenoiserPath = this._denoiserGgufPath;
        }
        if (this._backendsDir) {
            parameters.backendsDir = this._backendsDir;
        }
        if (this._openclCacheDir) {
            parameters.openclCacheDir = this._openclCacheDir;
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
        const response = this._job.start({
            signal: input?.signal,
        });
        if (input?.signal?.aborted)
            return response;
        try {
            await this._requireAddon().runJob({
                type: input.type || "text",
                input: input.input,
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
