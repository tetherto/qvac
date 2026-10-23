"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const bareOs = require("bare-os");
const loggingModule = require("@qvac/logging");
// Published logging releases expose a CJS constructor; the workspace exposes
// an ESM default. Bare require(ESM) returns a namespace without __esModule.
const loggingExport = loggingModule;
const QvacLogger = typeof loggingExport === "function" ? loggingExport : loggingExport.default;
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const tts_1 = require("./tts");
const addonEvents_1 = require("./lib/addonEvents");
const errorModule = __importStar(require("./lib/error"));
const fit_1 = require("./lib/fit");
const textStreamAccumulator_1 = require("./lib/textStreamAccumulator");
const engineIds_1 = require("./lib/engineIds");
const engineParams_1 = require("./lib/engineParams");
const audio8_1 = require("./lib/engines/audio8");
const parler_1 = require("./lib/engines/parler");
const exclusiveQueue_1 = require("./lib/exclusiveQueue");
const jobFields_1 = require("./lib/jobFields");
const pocketLifecycle_1 = require("./lib/pocketLifecycle");
const reload_1 = require("./lib/reload");
const sentenceStream_1 = require("./lib/sentenceStream");
const setup_1 = require("./lib/setup");
const streamingSupport_1 = require("./lib/streamingSupport");
const voiceControls_1 = require("./lib/voiceControls");
const { platform } = bareOs;
const { ERR_CODES, QvacErrorAddonTTSGgml } = errorModule;
/**
 * GGML-backed TTS via the `tts-cpp` library. Wraps the chatterbox,
 * supertonic, parler, cosyvoice3, audio8 and moss engines behind a single
 * engine-agnostic JavaScript surface. Engine type is auto-detected from
 * `files` or selected explicitly with `engine`.
 *
 * Owns a persistent native engine: model weights and voice-conditioning
 * tensors are loaded once by `load()` and reused by `run()`, `runStream()`,
 * and `runStreaming()`.
 */
class TTSGgml {
    static inferenceManagerConfig = {
        noAdditionalDownload: true,
    };
    static ENGINE_CHATTERBOX = engineIds_1.ENGINE_CHATTERBOX;
    static ENGINE_SUPERTONIC = engineIds_1.ENGINE_SUPERTONIC;
    static ENGINE_COSYVOICE3 = engineIds_1.ENGINE_COSYVOICE3;
    static ENGINE_PARLER = engineIds_1.ENGINE_PARLER;
    static ENGINE_AUDIO8 = engineIds_1.ENGINE_AUDIO8;
    static ENGINE_MOSS = engineIds_1.ENGINE_MOSS;
    static ENGINE_MOSS_SFX = engineIds_1.ENGINE_MOSS_SFX;
    static ENGINE_MOSS_SPEECH = engineIds_1.ENGINE_MOSS_SPEECH;
    static ENGINE_POCKET = engineIds_1.ENGINE_POCKET;
    opts;
    exclusiveRun;
    logger;
    state;
    addon;
    _job;
    _runExclusive;
    _exclusiveStreams = new exclusiveQueue_1.ExclusiveResponseQueue();
    /** Everything resolved from the constructor options; reload rewrites parts of it. */
    _setup;
    _sentenceStream;
    _events;
    /** The Pocket execution rules, or null for every other engine. */
    _pocket;
    _lazySessionLoading;
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
        this._job = (0, infer_base_1.createJobHandler)({
            cancel: () => this._pocket ? this.cancel() : this._optionalAddon()?.cancel(),
        });
        this._runExclusive = (0, exclusiveQueue_1.resolveExclusiveRunner)(this.exclusiveRun);
        this._lazySessionLoading = (0, setup_1.resolveDefaultLazySessionLoading)(options.lazySessionLoading);
        this._setup = (0, setup_1.resolveEngineSetup)(options);
        this._sentenceStream = new sentenceStream_1.SentenceStreamer({
            startJob: () => this._job.start(),
            dispatchJob: (job) => this._dispatchJob(job),
            endJob: (stats) => this._events.endJob(stats),
            failJob: (error) => this._job.fail(error),
            // Audio8 and MOSS report `tokensPerSecond` as codec frames per second,
            // so the streaming aggregate counts frames too rather than characters.
            countsFrames: () => this._setup.engineType === engineIds_1.ENGINE_AUDIO8 ||
                this._setup.engineType === engineIds_1.ENGINE_MOSS,
        });
        this._events = new addonEvents_1.AddonEventRouter({
            job: this._job,
            stream: this._sentenceStream,
            logger: () => this._getLogger(),
            reportStats: () => !!this.opts.stats,
        });
        this._pocket =
            this._setup.engineType === engineIds_1.ENGINE_POCKET
                ? new pocketLifecycle_1.PocketLifecycle({
                    setup: this._setup,
                    state: this.state,
                    logger: () => this._getLogger(),
                    optionalAddon: () => this._optionalAddon(),
                    setAddon: (addon) => {
                        this.addon = addon;
                    },
                    createAddon: (params) => this._spawnAddon(params),
                    unloadModel: () => this._unloadModel(),
                    activeJob: () => this._job.active,
                    failStream: (reason) => this._sentenceStream.fail(reason),
                })
                : null;
    }
    getEngineType() {
        return this._setup.engineType;
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
        return this._withPocketLifecycle(() => this._loadModel());
    }
    async _loadModel() {
        if (this.state.destroyed) {
            throw new QvacErrorAddonTTSGgml({
                code: ERR_CODES.FAILED_TO_LOAD,
                adds: "instance was destroyed",
            });
        }
        if (this.state.configLoaded || this.state.weightsLoaded) {
            this._getLogger().info("Reload requested - unloading existing model first");
            await this._unloadModel();
        }
        await this._load();
        this.state.configLoaded = true;
        this.state.weightsLoaded = true;
    }
    async run(input) {
        await this._pocket?.waitCancel();
        this._pocket?.checkReload();
        if (input?.streamOutput === true && this._setup.engineType !== engineIds_1.ENGINE_POCKET) {
            (0, streamingSupport_1.assertSentenceStreamingAllowed)(this._setup, "run with streamOutput");
            const text = (0, sentenceStream_1.requireStreamOutputText)(input.input);
            const jobFields = (0, jobFields_1.resolveJobFields)(this._setup, input, "run");
            const { locale, maxChunkScalars } = input;
            return this._startStream(() => this._runStreamOrchestrator(text, { locale, maxChunkScalars }, jobFields));
        }
        return this._runExclusive(() => this._runInternal(input));
    }
    /**
     * Chunked streaming synthesis. Equivalent to
     * `run({ input: text, streamOutput: true, ...options })`.
     */
    async runStream(text, options = {}) {
        await this._pocket?.waitCancel();
        this._pocket?.checkReload();
        const normalized = options == null || typeof options !== "object" ? {} : options;
        if (this._setup.engineType === engineIds_1.ENGINE_POCKET) {
            return this._startStream(() => this._runStreamOrchestrator(text, normalized, (0, jobFields_1.resolveJobFields)(this._setup, normalized, "runStream")));
        }
        return this.run({
            input: text,
            streamOutput: true,
            locale: normalized.locale,
            maxChunkScalars: normalized.maxChunkScalars,
            ...((0, parler_1.pickParlerDescFields)(normalized) ?? {}),
            ...((0, audio8_1.pickAudio8VoiceFields)(normalized) ?? {}),
            ...(normalized.instruct === undefined
                ? {}
                : { instruct: normalized.instruct }),
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
        await this._pocket?.waitCancel();
        this._pocket?.checkReload();
        (0, streamingSupport_1.assertSentenceStreamingAllowed)(this._setup, "runStreaming");
        const jobFields = (0, jobFields_1.resolveJobFields)(this._setup, options, "runStreaming");
        const streamOptions = (0, sentenceStream_1.resolveRunStreamingOptions)(textStream, options);
        let normalized = (0, sentenceStream_1.normalizeTextStream)(textStream);
        if (streamOptions.accumulateSentences) {
            normalized = (0, textStreamAccumulator_1.accumulateTextStream)(normalized, {
                sentenceDelimiterPreset: streamOptions.sentenceDelimiterPreset,
                maxBufferScalars: streamOptions.maxBufferScalars,
                flushAfterMs: streamOptions.flushAfterMs,
                sentenceDelimiter: streamOptions.sentenceDelimiter,
                language: this._setup.config.language,
            });
        }
        return this._startStream(() => {
            this._pocket?.checkRequest();
            return this._sentenceStream.streamText(normalized, jobFields);
        });
    }
    /** Streams line up behind each other under `exclusiveRun`; otherwise they start at once. */
    _startStream(run) {
        return this.exclusiveRun ? this._exclusiveStreams.enqueue(run) : run();
    }
    _runStreamOrchestrator(text, options, jobFields) {
        this._pocket?.checkRequest();
        const chunks = (0, sentenceStream_1.splitSentenceChunks)(text, options, this._setup.config.language);
        this._pocket?.checkRequest();
        return this._sentenceStream.streamChunks(chunks, jobFields);
    }
    async _load() {
        this._getLogger().info("[TTSGgml] Language:", this._setup.config.language || "en");
        const addon = this._spawnAddon(this._buildTtsParams());
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
        return (0, engineParams_1.buildNativeParams)(this._setup);
    }
    /** A native instance that reports through this wrapper's output callback. */
    _spawnAddon(configuration) {
        return this._createAddon(configuration, this._addonOutputCallback.bind(this));
    }
    _createAddon(configuration, outputCallback) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        return new tts_1.TTSInterface(binding, configuration, outputCallback);
    }
    async unload() {
        return this._withPocketLifecycle(() => this._unloadModel());
    }
    async _unloadModel() {
        await this.cancel();
        this._sentenceStream.fail("Model was unloaded");
        const addon = this._optionalAddon();
        try {
            if (addon)
                await addon.destroyInstance();
        }
        finally {
            if (this.addon === addon) {
                this.addon = null;
                this.state.configLoaded = false;
                this.state.weightsLoaded = false;
            }
        }
    }
    async destroy() {
        return this._withPocketLifecycle(async () => {
            await this._unloadModel();
            this.state.destroyed = true;
        });
    }
    async _withPocketLifecycle(action) {
        return this._pocket ? this._pocket.withLifecycle(action) : action();
    }
    async _runInternal(input) {
        await this._pocket?.waitCancel();
        this._pocket?.checkRequest();
        const jobFields = (0, jobFields_1.resolveJobFields)(this._setup, input, "run");
        const signal = input?.signal;
        // Pocket keeps the signal to itself: the abort fails the response with
        // the caller's reason and stops native work behind the completion barrier.
        const pocketSignal = this._pocket && signal && !signal.aborted ? signal : undefined;
        const response = this._job.start({
            signal: pocketSignal ? undefined : signal,
        });
        if (signal?.aborted)
            return response;
        if (pocketSignal)
            this._pocket?.attachAbort(response, pocketSignal);
        try {
            await this._dispatchJob({
                type: input.type || "text",
                input: input.input,
                ...(jobFields ?? {}),
            });
        }
        catch (error) {
            this._job.fail((0, sentenceStream_1.normalizeError)(error));
            throw error;
        }
        return response;
    }
    _addonOutputCallback(_addon, event, data, error) {
        this._pocket?.onNativeEvent(data, error);
        this._events.route(event, data, error);
    }
    async _dispatchJob(input) {
        const addon = this._requireAddon();
        if (this._setup.engineType === engineIds_1.ENGINE_AUDIO8 && this._sentenceStream.ctx) {
            return addon.runJob({ ...input, streamOutput: true });
        }
        return this._pocket ? this._pocket.runJob(addon, input) : addon.runJob(input);
    }
    async cancel() {
        if (this._pocket)
            return this._pocket.cancel();
        const addon = this._optionalAddon();
        if (addon?.cancel)
            await addon.cancel();
    }
    async reload(newConfig = {}) {
        this._getLogger().debug("Reloading addon with new configuration", newConfig);
        if (this._pocket)
            return this._pocket.reload(newConfig);
        const parameters = (0, reload_1.applyReloadableConfig)(this._setup, newConfig);
        await this.cancel();
        this._sentenceStream.fail("Model was reloaded");
        const existingAddon = this._optionalAddon();
        if (existingAddon)
            await existingAddon.destroyInstance();
        this.addon = this._spawnAddon(parameters);
        await this._requireAddon().activate();
    }
    static getModelKey(_params) {
        void _params;
        return "tts-ggml";
    }
    /**
     * tts-cpp's canonical emotion / pace vocabulary and each engine's supported
     * subset, read from the native library without loading a model. Engines are
     * keyed by engine type, so tts-cpp's `cosyvoice` appears as `cosyvoice3`;
     * an engine this package does not wrap keeps its tts-cpp name.
     */
    static getVoiceControls() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        return (0, voiceControls_1.toVoiceControlsCatalog)(binding.getVoiceControls());
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
// eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging preserves the established class namespace API.
(function (TTSGgml) {
    TTSGgml.QvacErrorAddonTTSGgml = errorModule.QvacErrorAddonTTSGgml;
    TTSGgml.ERR_CODES = errorModule.ERR_CODES;
    TTSGgml.assessFit = fit_1.assessFit;
})(TTSGgml || (TTSGgml = {}));
module.exports.QvacErrorAddonTTSGgml =
    errorModule.QvacErrorAddonTTSGgml;
module.exports.ERR_CODES =
    errorModule.ERR_CODES;
module.exports = TTSGgml;
