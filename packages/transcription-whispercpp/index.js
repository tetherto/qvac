"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const path = require("bare-path");
const fs = require("bare-fs");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const whisper_1 = require("./whisper");
const configChecker_1 = require("./configChecker");
const error_1 = require("./lib/error");
const PREBUILDS_DIR = path.join(__dirname, "prebuilds");
const END_OF_INPUT = "end of job";
const MS_PER_SECOND = 1000;
const DEFAULT_AUDIO_FORMAT = "s16le";
const DEFAULT_VAD_THRESHOLD = 0.6;
const DEFAULT_WHISPER_CONFIG = Object.freeze({
    language: "en",
    durationMs: 0,
    temperature: 0.0,
    suppressNst: true,
    nThreads: 0,
});
const NON_ADDON_WHISPER_KEYS = [
    "audio_format",
    "contextParams",
    "miscConfig",
    "vadModelPath",
    "vad_params",
    "backendsDir",
    "max_seconds",
];
const DEFAULT_STREAMING_VAD_CONFIG = Object.freeze({
    vadThreshold: 0.5,
    minSilenceDurationMs: 500,
    minSpeechDurationMs: 250,
    maxSpeechDurationS: 30,
    speechPadMs: 30,
    samplesOverlap: 0.1,
    endOfTurnSilenceMs: 0,
});
/**
 * GGML client implementation for the Whisper transcription model.
 */
class TranscriptionWhispercpp {
    logger;
    exclusiveRun;
    opts;
    state;
    params;
    addon;
    _files;
    _config;
    _withExclusiveRun;
    _inferenceQueueWaiter;
    _pendingWhisperJobId;
    _job;
    constructor({ files, logger = null, exclusiveRun = true, opts = {}, }, config) {
        if (!files || typeof files.model !== "string" || files.model.length === 0) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.MODEL_REQUIRED,
                adds: "files.model is required",
            });
        }
        this.opts = opts;
        this.logger = new QvacLogger(logger);
        this.exclusiveRun = !!exclusiveRun;
        this._withExclusiveRun = (0, infer_base_1.exclusiveRunQueue)();
        this.state = {
            configLoaded: false,
            weightsLoaded: false,
            destroyed: false,
        };
        const vadModel = typeof files.vadModel === "string" && files.vadModel.length > 0
            ? files.vadModel
            : null;
        this._files = { model: files.model, vadModel };
        this._config = config;
        this.params = config.whisperConfig;
        this._inferenceQueueWaiter = Promise.resolve();
        this._pendingWhisperJobId = null;
        this._job = (0, infer_base_1.createJobHandler)({
            cancel: () => {
                const jobId = this._pendingWhisperJobId ?? this.addon?._activeJobId;
                return this.addon?.cancel?.(jobId ?? undefined);
            },
        });
        this.logger.debug("TranscriptionWhispercpp constructor called", {
            params: this.params,
            config: this._config,
            modelPath: this._files.model,
            vadModelPath: this._files.vadModel,
        });
        this.validateModelFiles();
    }
    getState() {
        return this.state;
    }
    async load(...loadArgs) {
        if (this.state.destroyed) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
                adds: "instance was destroyed",
            });
        }
        if (this.state.configLoaded || this.state.weightsLoaded) {
            this.logger.info("Reload requested - unloading existing model first");
            await this.unload();
        }
        await this._load(...loadArgs);
        this.state.configLoaded = true;
        this.state.weightsLoaded = true;
    }
    async pause() {
        if (!this.addon?.pause) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_PAUSE,
                adds: "pause not supported",
            });
        }
        await this.addon.pause();
    }
    async unpause() {
        if (!this.addon?.activate) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_ACTIVATE,
                adds: "activate not supported",
            });
        }
        await this.addon.activate();
    }
    async stop() {
        if (!this.addon?.stop) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_STOP,
                adds: "stop not supported",
            });
        }
        await this.addon.stop();
    }
    async status() {
        if (!this.addon?.status) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_GET_STATUS,
                adds: "status not supported",
            });
        }
        return await this.addon.status();
    }
    _resolveVadModelPath() {
        if (this._config.vadModelPath)
            return this._config.vadModelPath;
        if (this._files.vadModel)
            return this._files.vadModel;
        if (typeof this.params?.vad_model_path === "string") {
            return this.params.vad_model_path;
        }
        return null;
    }
    async _load(..._loadArgs) {
        void _loadArgs;
        this.logger.debug("TranscriptionWhispercpp _load (local model files)");
        const configurationParams = this._buildConfigurationParams();
        _checkParamsExists(configurationParams);
        this.addon = this._createAddon(configurationParams);
        await this.addon.activate();
        this.logger.debug("Addon activated");
    }
    _getModelFilePath() {
        return this._files.model;
    }
    _buildConfigurationParams(overrides = {}) {
        return {
            contextParams: {
                model: this._config.path || this._getModelFilePath(),
                ...(this._config.contextParams || {}),
            },
            whisperConfig: this._buildWhisperConfig(overrides.whisperConfig || {}),
            miscConfig: overrides.miscConfig || {
                caption_enabled: false,
                ...(this._config.miscConfig || {}),
            },
            audio_format: overrides.audio_format ||
                this._config.audio_format ||
                this.params.audio_format ||
                DEFAULT_AUDIO_FORMAT,
            backendsDir: typeof this.params.backendsDir === "string"
                ? this.params.backendsDir
                : PREBUILDS_DIR,
        };
    }
    _buildWhisperConfig(overrideWhisperConfig) {
        const whisperConfig = {
            ...this.params,
            language: this.params.language || DEFAULT_WHISPER_CONFIG.language,
            duration_ms: this._resolveDurationMs(overrideWhisperConfig),
            temperature: this.params.temperature ?? DEFAULT_WHISPER_CONFIG.temperature,
            suppress_nst: this.params.suppress_nst ?? DEFAULT_WHISPER_CONFIG.suppressNst,
            n_threads: this.params.n_threads || DEFAULT_WHISPER_CONFIG.nThreads,
        };
        this._stripNonAddonKeys(whisperConfig);
        this._applyVadConfig(whisperConfig, overrideWhisperConfig);
        return whisperConfig;
    }
    _resolveDurationMs(overrideWhisperConfig) {
        const fromMaxSeconds = this.params.max_seconds
            ? this.params.max_seconds * MS_PER_SECOND
            : DEFAULT_WHISPER_CONFIG.durationMs;
        return overrideWhisperConfig.duration_ms ?? fromMaxSeconds;
    }
    _stripNonAddonKeys(whisperConfig) {
        for (const key of NON_ADDON_WHISPER_KEYS) {
            delete whisperConfig[key];
        }
    }
    _applyVadConfig(whisperConfig, overrideWhisperConfig) {
        const vadModelPath = this._resolveVadModelPath();
        if (!vadModelPath)
            return;
        whisperConfig.vad_model_path = vadModelPath;
        whisperConfig.vadParams =
            overrideWhisperConfig.vad_params ||
                this.params.vad_params || { threshold: DEFAULT_VAD_THRESHOLD };
    }
    async _enqueueExclusiveRunResponse(runFn) {
        const prev = this._inferenceQueueWaiter || Promise.resolve();
        let releaseSlot = () => { };
        this._inferenceQueueWaiter = new Promise((resolve) => {
            releaseSlot = resolve;
        });
        await prev;
        let response;
        try {
            response = await runFn();
        }
        catch (err) {
            releaseSlot();
            throw err;
        }
        void response
            .await()
            .finally(() => {
            releaseSlot();
        })
            .catch(() => { });
        return response;
    }
    async run(audioStream) {
        if (this.exclusiveRun) {
            return await this._enqueueExclusiveRunResponse(() => this._runInternal(audioStream));
        }
        return await this._runInternal(audioStream);
    }
    async runStreaming(audioStream, opts = {}) {
        if (this.exclusiveRun) {
            return await this._enqueueExclusiveRunResponse(() => this._runInternal(audioStream, { ...opts, streaming: true }));
        }
        return await this._runInternal(audioStream, {
            ...opts,
            streaming: true,
        });
    }
    async _runInternal(audioStream, opts = {}) {
        const normalizedAudioStream = this._normalizeAudioStream(audioStream);
        if (opts.streaming) {
            return this._runStreaming(normalizedAudioStream, opts);
        }
        return this._runBatchTranscription(normalizedAudioStream);
    }
    async _runBatchTranscription(normalizedAudioStream) {
        const addon = this._requiredAddon();
        this._pendingWhisperJobId = await addon.append({
            type: "audio",
            input: new Uint8Array(),
        });
        const response = this._job.start();
        const finalized = response.await();
        void finalized.catch(() => { });
        response.await = () => finalized;
        void this._handleAudioStream(normalizedAudioStream).catch((error) => {
            this._pendingWhisperJobId = null;
            this._job.fail(error);
        });
        return response;
    }
    _runStreaming(audioStream, streamingOpts = {}) {
        const vadModelPath = this._resolveVadModelPath();
        if (!vadModelPath) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.VAD_MODEL_REQUIRED,
            });
        }
        const addon = this._requiredAddon();
        const streamingConfig = this._buildStreamingConfig(vadModelPath, streamingOpts);
        addon.startStreaming(streamingConfig);
        this._pendingWhisperJobId = null;
        const response = this._job.start();
        const finalized = response.await().finally(() => {
            addon.finishStreaming();
        });
        void finalized.catch(() => { });
        response.await = () => finalized;
        void this._handleStreamingAudio(audioStream).catch((error) => {
            this._pendingWhisperJobId = null;
            this._job.fail(error);
        });
        return Promise.resolve(response);
    }
    _buildStreamingConfig(vadModelPath, streamingOpts) {
        const vadParams = this.params?.vad_params || {};
        const defaults = DEFAULT_STREAMING_VAD_CONFIG;
        const streamingConfig = {
            vadModelPath,
            vadThreshold: vadParams.threshold || defaults.vadThreshold,
            minSilenceDurationMs: vadParams.min_silence_duration_ms ||
                defaults.minSilenceDurationMs,
            minSpeechDurationMs: vadParams.min_speech_duration_ms ||
                defaults.minSpeechDurationMs,
            maxSpeechDurationS: vadParams.max_speech_duration_s || defaults.maxSpeechDurationS,
            speechPadMs: vadParams.speech_pad_ms || defaults.speechPadMs,
            samplesOverlap: vadParams.samples_overlap || defaults.samplesOverlap,
            emitVadEvents: Boolean(streamingOpts.emitVadEvents || streamingOpts.conversationMode),
            endOfTurnSilenceMs: streamingOpts.endOfTurnSilenceMs ||
                defaults.endOfTurnSilenceMs,
        };
        if (streamingOpts.vadRunIntervalMs !== undefined) {
            streamingConfig.vadRunIntervalMs =
                streamingOpts.vadRunIntervalMs;
        }
        return streamingConfig;
    }
    async _handleAudioStream(audioStream) {
        this.logger.debug("Start handling audio stream", {
            modelPath: this._getModelFilePath(),
        });
        const addon = this._requiredAddon();
        for await (const chunk of audioStream) {
            this.logger.debug("Appending audio chunk", {
                chunkLength: chunk.length,
            });
            await addon.append({
                type: "audio",
                input: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
            });
        }
        this.logger.debug("Sending end-of-input signal");
        await addon.append({ type: END_OF_INPUT });
    }
    async _handleStreamingAudio(audioStream) {
        this.logger.debug("Start handling streaming audio");
        const addon = this._requiredAddon();
        for await (const chunk of audioStream) {
            addon.appendStreamingAudio({
                type: "audio",
                input: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
            });
        }
        this.logger.debug("Ending streaming session");
        addon.endStreaming();
    }
    _normalizeAudioStream(audioStream) {
        if (!audioStream) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.INVALID_AUDIO_INPUT,
                adds: "audioStream is required",
            });
        }
        if (typeof audioStream[Symbol.asyncIterator] === "function") {
            return audioStream;
        }
        if (audioStream instanceof Uint8Array)
            return [audioStream];
        if (Array.isArray(audioStream)) {
            return audioStream;
        }
        if (typeof audioStream[Symbol.iterator] === "function") {
            return [Uint8Array.from(audioStream)];
        }
        throw new error_1.QvacErrorAddonWhisper({
            code: error_1.ERR_CODES.INVALID_AUDIO_INPUT,
            adds: "Unsupported audio input. Expected stream, Uint8Array, or chunk array.",
        });
    }
    async reload(newConfig = {}) {
        return await this._withExclusiveRun(async () => {
            this.logger.debug("Reloading addon with new configuration", newConfig);
            if (newConfig.whisperConfig) {
                this.params = { ...this.params, ...newConfig.whisperConfig };
            }
            const configurationParams = this._buildConfigurationParams({
                whisperConfig: newConfig.whisperConfig,
                miscConfig: newConfig.miscConfig,
                audio_format: newConfig.audio_format,
            });
            _checkParamsExists(configurationParams);
            this._pendingWhisperJobId = null;
            if (this._job.active) {
                this._job.fail(new Error("Model was reloaded"));
            }
            await this.cancel();
            const addon = this._requiredAddon();
            await addon.reload(configurationParams);
            await addon.activate();
            this.logger.debug("Addon reloaded and activated successfully");
        });
    }
    _createAddon(configurationParams) {
        this.logger.info("Creating Whisper interface with configuration:", configurationParams);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        return new whisper_1.WhisperInterface(binding, configurationParams, this._outputCallback.bind(this), this.logger.info.bind(this.logger));
    }
    _outputCallback(_addon, event, jobId, data, error) {
        if (event === "Error") {
            this.logger.error(`Job failed with error: ${String(error)}`);
            this._pendingWhisperJobId = null;
            this._job.fail(error);
            return;
        }
        if (event === "Output") {
            try {
                this.logger.debug(`Job produced output: ${dataAsStringWhisper(data)}`);
            }
            catch (err) {
                this.logger.error(`Failed to serialize output for logging: ${errorMessage(err)}`);
                this.logger.debug("Job produced output: [non-serializable data]");
            }
            this._job.output(data);
            return;
        }
        if (event === "VadState" || event === "EndOfTurn") {
            this.logger.debug(`Job produced conversation event: ${dataAsStringWhisper(data)}`);
            this._job.output(data);
            return;
        }
        if (event === "JobEnded") {
            this.logger.info(`Job ${jobId} completed. Stats: ${JSON.stringify(data)}`);
            this._pendingWhisperJobId = null;
            if (this.opts?.stats)
                this._job.end(data);
            else
                this._job.end();
            return;
        }
        this.logger.debug(`Received event for job ${jobId}: ${event}`);
    }
    async unload() {
        return await this._withExclusiveRun(async () => {
            this._pendingWhisperJobId = null;
            if (this._job.active) {
                this._job.fail(new Error("Model was unloaded"));
            }
            await this.cancel();
            if (this.addon)
                await this.addon.destroyInstance();
            this.state.configLoaded = false;
            this.state.weightsLoaded = false;
        });
    }
    async cancel() {
        if (this.addon?.cancel)
            await this.addon.cancel();
        this._pendingWhisperJobId = null;
        if (this._job.active) {
            this._job.fail(new Error("Job cancelled"));
        }
    }
    async destroy() {
        return await this._withExclusiveRun(async () => {
            this._pendingWhisperJobId = null;
            if (this._job.active) {
                this._job.fail(new Error("Model was destroyed"));
            }
            await this.cancel();
            if (this.addon)
                await this.addon.destroyInstance();
            this.state.configLoaded = false;
            this.state.weightsLoaded = false;
            this.state.destroyed = true;
        });
    }
    validateModelFiles() {
        const modelPath = this._config.path || this._getModelFilePath();
        if (!modelPath || !fs.existsSync(modelPath)) {
            this.logger.error("Model file not found", { path: modelPath });
            throw new Error(modelPath
                ? `Model file doesn't exist: ${modelPath}`
                : "Model file doesn't exist");
        }
        const vadModelPath = this._resolveVadModelPath();
        if (vadModelPath && !fs.existsSync(vadModelPath)) {
            this.logger.error("VAD model file not found", {
                path: vadModelPath,
            });
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.VAD_MODEL_NOT_FOUND,
                adds: vadModelPath,
            });
        }
    }
    _requiredAddon() {
        if (!this.addon)
            throw new Error("Addon is not loaded");
        return this.addon;
    }
}
function dataAsStringWhisper(data) {
    if (!data)
        return "";
    if (typeof data === "object")
        return JSON.stringify(data);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- mirrors the prior runtime's data.toString() fallback.
    return String(data);
}
function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    if (err && typeof err === "object" && "message" in err) {
        const message = err.message;
        if (typeof message === "string" && message)
            return message;
    }
    return typeof err === "string" ? err : "unknown error";
}
function _checkParamsExists(params) {
    (0, configChecker_1.checkConfig)(params);
}
// The namespace merge preserves the package's established `export =` API and
// namespace-qualified public types such as `TranscriptionWhispercpp.RuntimeStats`.
// eslint-disable-next-line @typescript-eslint/no-namespace
(function (TranscriptionWhispercpp) {
    let BackendId;
    (function (BackendId) {
        BackendId[BackendId["CPU"] = 0] = "CPU";
        BackendId[BackendId["Metal"] = 1] = "Metal";
        BackendId[BackendId["CUDA"] = 2] = "CUDA";
        BackendId[BackendId["Vulkan"] = 3] = "Vulkan";
        BackendId[BackendId["OpenCL"] = 4] = "OpenCL";
        BackendId[BackendId["Other"] = 99] = "Other";
    })(BackendId = TranscriptionWhispercpp.BackendId || (TranscriptionWhispercpp.BackendId = {}));
})(TranscriptionWhispercpp || (TranscriptionWhispercpp = {}));
module.exports = TranscriptionWhispercpp;
