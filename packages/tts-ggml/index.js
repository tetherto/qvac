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
const errorModule = __importStar(require("./lib/error"));
const fit_1 = require("./lib/fit");
const pocketConfig_1 = require("./lib/pocketConfig");
const textStreamAccumulator_1 = require("./lib/textStreamAccumulator");
const engineIds_1 = require("./lib/engineIds");
const engineParams_1 = require("./lib/engineParams");
const audio8_1 = require("./lib/engines/audio8");
const parler_1 = require("./lib/engines/parler");
const jobFields_1 = require("./lib/jobFields");
const reload_1 = require("./lib/reload");
const sentenceStream_1 = require("./lib/sentenceStream");
const setup_1 = require("./lib/setup");
const streamingSupport_1 = require("./lib/streamingSupport");
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
    /** Everything resolved from the constructor options; reload rewrites parts of it. */
    _setup;
    _sentenceStream;
    _ttsInferenceQueueWaiter;
    _lazySessionLoading;
    _pocketJobPending = null;
    _pocketCancelPromise = null;
    _pocketLifecycleInProgress = false;
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
        this._ttsInferenceQueueWaiter = Promise.resolve();
        this._job = (0, infer_base_1.createJobHandler)({
            cancel: () => this._setup.engineType === engineIds_1.ENGINE_POCKET
                ? this.cancel()
                : this._optionalAddon()?.cancel(),
        });
        this._runExclusive = this.exclusiveRun
            ? (0, infer_base_1.exclusiveRunQueue)()
            : async function runNow(callback) {
                return callback();
            };
        this._lazySessionLoading = (0, setup_1.resolveDefaultLazySessionLoading)(options.lazySessionLoading);
        this._setup = (0, setup_1.resolveEngineSetup)(options);
        this._sentenceStream = new sentenceStream_1.SentenceStreamer({
            startJob: () => this._job.start(),
            dispatchJob: (job) => this._dispatchJob(job),
            endJob: (stats) => this._endJobWithStats(stats),
            failJob: (error) => this._job.fail(error),
            countsFrames: () => this._pacesOnFrames(),
        });
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
        await this._waitPocketCancel();
        this._checkPocketReload();
        if (input?.streamOutput === true && this._setup.engineType !== engineIds_1.ENGINE_POCKET) {
            (0, streamingSupport_1.assertSentenceStreamingAllowed)(this._setup, "run with streamOutput");
            if (typeof input.input !== "string" ||
                input.input.trim().length === 0) {
                throw new QvacErrorAddonTTSGgml({
                    code: ERR_CODES.FAILED_TO_APPEND,
                    adds: "run with streamOutput: non-empty string `input` is required",
                });
            }
            const jobFields = (0, jobFields_1.resolveJobFields)(this._setup, input, "run");
            const runStream = () => this._runStreamOrchestrator(input.input, {
                locale: input.locale,
                maxChunkScalars: input.maxChunkScalars,
            }, jobFields);
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
        await this._waitPocketCancel();
        this._checkPocketReload();
        const normalized = options == null || typeof options !== "object" ? {} : options;
        if (this._setup.engineType === engineIds_1.ENGINE_POCKET) {
            const run = () => this._runStreamOrchestrator(text, normalized, (0, jobFields_1.resolveJobFields)(this._setup, normalized, "runStream"));
            return this.exclusiveRun ? this._enqueueExclusiveTtsResponse(run) : run();
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
        await this._waitPocketCancel();
        this._checkPocketReload();
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
        const runStream = () => this._runTextStreamOrchestrator(normalized, jobFields);
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
    _runTextStreamOrchestrator(source, jobFields) {
        this._checkPocketRequest();
        return this._sentenceStream.streamText(source, jobFields);
    }
    _runStreamOrchestrator(text, options, jobFields) {
        this._checkPocketRequest();
        const chunks = (0, sentenceStream_1.splitSentenceChunks)(text, options, this._setup.config.language);
        this._checkPocketRequest();
        return this._sentenceStream.streamChunks(chunks, jobFields);
    }
    /**
     * Audio8 and MOSS report `tokensPerSecond` as codec frames per second, so
     * the streaming aggregate has to count frames too rather than characters.
     */
    _pacesOnFrames() {
        return (this._setup.engineType === engineIds_1.ENGINE_AUDIO8 ||
            this._setup.engineType === engineIds_1.ENGINE_MOSS);
    }
    async _load() {
        this._getLogger().info("[TTSGgml] Language:", this._setup.config.language || "en");
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
        return (0, engineParams_1.buildNativeParams)(this._setup);
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
    async _runInternal(input) {
        await this._waitPocketCancel();
        this._checkPocketRequest();
        const jobFields = (0, jobFields_1.resolveJobFields)(this._setup, input, "run");
        const signal = input?.signal;
        const pocketSignal = this._setup.engineType === engineIds_1.ENGINE_POCKET && signal && !signal.aborted
            ? signal
            : undefined;
        const response = this._job.start({
            signal: pocketSignal ? undefined : signal,
        });
        if (signal?.aborted)
            return response;
        if (pocketSignal) {
            const onAbort = () => {
                if (this._job.active !== response)
                    return;
                const reason = pocketSignal.reason;
                const error = reason instanceof Error ? reason : new Error(typeof reason === "string" ? `Aborted: ${reason}` : "Aborted");
                // Preserve the caller's reason while stopping native work. Cancellation
                // retains the completion barrier until its terminal callback arrives.
                try {
                    response.failed(error);
                }
                finally {
                    void this.cancel().catch((error) => this._getLogger().error("Pocket abort cancellation failed", error));
                }
            };
            pocketSignal.addEventListener("abort", onAbort, { once: true });
            const detach = () => pocketSignal.removeEventListener("abort", onAbort);
            void response.await().then(detach, detach);
        }
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
    _endJobWithStats(stats) {
        if (this.opts.stats)
            this._job.end(stats);
        else
            this._job.end();
    }
    _addonOutputCallback(_addon, event, data, error) {
        if (this._pocketJobPending && ((typeof error === "string" && error.length > 0) || (0, sentenceStream_1.isStatsEvent)(data))) {
            const pending = this._pocketJobPending;
            this._pocketJobPending = null;
            pending.resolve();
        }
        if (typeof error === "string" && error.length > 0) {
            this._handleAddonError(error);
        }
        else if ((0, sentenceStream_1.isAudioOutputEvent)(data)) {
            this._handleAddonOutput(data);
        }
        else if ((0, sentenceStream_1.isStatsEvent)(data)) {
            this._handleAddonStats(data);
        }
        else {
            this._getLogger().debug(`Received TTS event: ${String(event)}`);
        }
    }
    _handleAddonError(error) {
        this._getLogger().error(`TTS job failed with error: ${error}`);
        this._sentenceStream.rejectActiveChunk(new Error(error));
        this._job.fail(error);
    }
    _handleAddonOutput(data) {
        try {
            this._getLogger().debug(`TTS job produced output: ${(0, sentenceStream_1.ttsOutputDebugString)(data)}`);
        }
        catch (error) {
            if (error instanceof RangeError) {
                this._getLogger().debug("TTS job produced output: [data too large]");
            }
            else {
                throw error;
            }
        }
        this._job.output(this._sentenceStream.ctx
            ? this._sentenceStream.enrich(data)
            : data);
    }
    _handleAddonStats(data) {
        this._getLogger().info(`TTS job completed. Stats: ${JSON.stringify(data)}`);
        if (!this._sentenceStream.onStats(data))
            this._endJobWithStats(data);
    }
    async _waitPocketCancel() {
        if (this._setup.engineType === engineIds_1.ENGINE_POCKET && this._pocketCancelPromise)
            await this._pocketCancelPromise;
    }
    async _withPocketLifecycle(action) {
        if (this._setup.engineType !== engineIds_1.ENGINE_POCKET)
            return action();
        await this._waitPocketCancel();
        this._checkPocketReload();
        this._pocketLifecycleInProgress = true;
        try {
            await action();
        }
        finally {
            this._pocketLifecycleInProgress = false;
        }
    }
    _checkPocketReload() {
        if (this._pocketLifecycleInProgress)
            throw new Error("Pocket lifecycle operation is already in progress");
    }
    _checkPocketRequest() {
        if (this._setup.engineType === engineIds_1.ENGINE_POCKET) {
            if (this.state.destroyed)
                throw new Error("Pocket instance was destroyed");
            if (!this.state.weightsLoaded || !this._optionalAddon())
                throw new Error("Pocket model is not loaded");
        }
        if (this._setup.engineType === engineIds_1.ENGINE_POCKET && (this._job.active || this._pocketJobPending)) {
            throw new Error("Pocket synthesis is already in progress");
        }
        this._checkPocketReload();
    }
    async _dispatchJob(input) {
        const addon = this._requireAddon();
        if (this._setup.engineType !== engineIds_1.ENGINE_POCKET)
            return addon.runJob(input);
        if (this._pocketJobPending)
            throw new Error("Pocket native job is already in progress");
        let resolve = () => { };
        const promise = new Promise((done) => { resolve = done; });
        const pending = { promise, resolve };
        this._pocketJobPending = pending;
        try {
            await addon.runJob(input);
        }
        catch (error) {
            if (this._pocketJobPending === pending)
                this._pocketJobPending = null;
            resolve();
            throw error;
        }
    }
    async cancel() {
        const addon = this._optionalAddon();
        if (this._setup.engineType !== engineIds_1.ENGINE_POCKET) {
            if (addon?.cancel)
                await addon.cancel();
            return;
        }
        if (this._pocketCancelPromise)
            return this._pocketCancelPromise;
        const pending = this._pocketJobPending;
        this._pocketCancelPromise = (async () => {
            this._sentenceStream.fail("Synthesis cancelled");
            if (addon?.cancel)
                await addon.cancel();
            // Joining the worker can precede delivery of its terminal callback.
            if (pending)
                await pending.promise;
        })();
        try {
            await this._pocketCancelPromise;
        }
        finally {
            this._pocketCancelPromise = null;
        }
    }
    async _reloadPocket(newConfig) {
        await this._waitPocketCancel();
        this._checkPocketReload();
        if (this.state.destroyed)
            throw new Error("Pocket instance was destroyed");
        const pocket = this._setup.pocket;
        if (!pocket)
            throw new Error("Pocket engine is not configured");
        const options = { ...pocket.options, ...newConfig };
        const config = { ...this._setup.config, ...newConfig };
        const params = (0, pocketConfig_1.buildPocketParams)(pocket.files, options, config);
        this._pocketLifecycleInProgress = true;
        let replacement = null;
        try {
            // Drain native work and release its model before allocating another one.
            // Failed activation leaves the instance unloaded with its last good config.
            await this._unloadModel();
            replacement = this._createAddon(params, this._addonOutputCallback.bind(this));
            await replacement.activate();
            this.addon = replacement;
            replacement = null;
            this._setup.pocket = { files: pocket.files, options, params };
            this._setup.config.language = "en";
            this._setup.config.useGPU = false;
            this._setup.outputSampleRate = typeof params.outputSampleRate === "number" ? params.outputSampleRate : null;
            this._setup.config.outputSampleRate = this._setup.outputSampleRate ?? undefined;
            this.state.configLoaded = true;
            this.state.weightsLoaded = true;
        }
        finally {
            try {
                if (replacement)
                    await replacement.destroyInstance();
            }
            finally {
                this._pocketLifecycleInProgress = false;
            }
        }
    }
    async reload(newConfig = {}) {
        this._getLogger().debug("Reloading addon with new configuration", newConfig);
        if (this._setup.engineType === engineIds_1.ENGINE_POCKET)
            return this._reloadPocket(newConfig);
        const parameters = (0, reload_1.applyReloadableConfig)(this._setup, newConfig);
        await this.cancel();
        this._sentenceStream.fail("Model was reloaded");
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
    /**
     * tts-cpp's canonical emotion / pace vocabulary and each engine's supported
     * subset, read from the native library without loading a model. Engines are
     * keyed by engine type, so tts-cpp's `cosyvoice` appears as `cosyvoice3`;
     * an engine this package does not wrap keeps its tts-cpp name.
     */
    static getVoiceControls() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        const native = binding.getVoiceControls();
        const engines = {};
        for (const [name, controls] of Object.entries(native.engines)) {
            engines[engineIds_1.FABRIC_ENGINE_TYPES[name] ?? name] = {
                emotions: [...controls.emotions],
                paces: [...controls.paces],
            };
        }
        return {
            emotions: [...native.emotions],
            paces: [...native.paces],
            engines,
        };
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
