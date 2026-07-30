"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhisperDriver = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const path = require("bare-path");
const whisper_1 = require("./whisper");
const configChecker_1 = require("./configChecker");
const error_1 = require("../../lib/error");
const constants_1 = require("../../lib/constants");
const audio_1 = require("../../lib/audio");
const PREBUILDS_DIR = path.join(__dirname, "..", "..", "prebuilds");
const MS_PER_SECOND = 1000;
const DEFAULT_BYTE_FORMAT = "s16le";
/** The native wire format is pinned; all input is normalized to f32. */
const WIRE_AUDIO_FORMAT = "f32le";
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
const WHISPER_STREAMING_OPT_KEYS = [
    "emitVadEvents",
    "conversationMode",
    "endOfTurnSilenceMs",
    "vadRunIntervalMs",
];
function dataAsString(data) {
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
function isRecord(value) {
    return Boolean(value) && typeof value === "object";
}
function bytesOf(chunk) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}
/**
 * Whisper engine driver: owns the `WhisperInterface`, the whisper event
 * mapping, and the whisper streaming lifecycle.
 */
class WhisperDriver {
    engineType = "whisper";
    supportsReload = true;
    addon;
    params;
    ctx;
    _files;
    _config;
    _byteFormat;
    _pendingJobId;
    constructor(ctx, files, config) {
        this.ctx = ctx;
        const vadModel = typeof files.vadModel === "string" && files.vadModel.length > 0
            ? files.vadModel
            : null;
        this._files = { model: files.model, vadModel };
        this._config = config;
        this.params = config.whisperConfig || {};
        this._byteFormat = this._resolveByteFormat();
        this._pendingJobId = null;
    }
    validateConfig() {
        (0, configChecker_1.checkConfig)(this._buildConfigurationParams());
    }
    normalizeAudio(input) {
        return (0, audio_1.normalizeAudioStream)(input, this._byteFormat);
    }
    async load() {
        this.ctx.logger.debug("WhisperDriver load (local model files)");
        const configurationParams = this._buildConfigurationParams();
        (0, configChecker_1.checkConfig)(configurationParams);
        this.addon = this._createAddon(configurationParams);
        // The batch-buffer cap is denominated in caller-supplied bytes, not in
        // the f32 wire bytes the driver appends. See MAX_BUFFERED_BYTES.
        this.addon.setSourceByteFormat(this._byteFormat);
        await this.addon.activate();
        this.ctx.logger.debug("Addon activated");
    }
    async unload() {
        if (this.addon)
            await this.addon.destroyInstance();
    }
    async reload(newConfig = {}) {
        const overrides = newConfig;
        this.ctx.logger.debug("Reloading addon with new configuration", overrides);
        if (overrides.whisperConfig) {
            this.params = { ...this.params, ...overrides.whisperConfig };
        }
        const configurationParams = this._buildConfigurationParams({
            whisperConfig: overrides.whisperConfig,
            miscConfig: overrides.miscConfig,
            audio_format: overrides.audio_format,
        });
        (0, configChecker_1.checkConfig)(configurationParams);
        this._pendingJobId = null;
        if (this.ctx.job.active) {
            this.ctx.job.fail(new Error("Model was reloaded"));
        }
        await this.cancelActive();
        const addon = this._requiredAddon();
        await addon.reload(configurationParams);
        addon.setSourceByteFormat(this._byteFormat);
        await addon.activate();
        this.ctx.logger.debug("Addon reloaded and activated successfully");
    }
    async cancelActive(jobId) {
        const target = jobId ?? this._pendingJobId ?? undefined;
        if (this.addon?.cancel)
            await this.addon.cancel(target);
        this._pendingJobId = null;
        if (this.ctx.job.active) {
            this.ctx.job.fail(new Error("Job cancelled"));
        }
    }
    async status() {
        if (!this.addon?.status) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.FAILED_TO_GET_STATUS,
                adds: "status not supported",
            });
        }
        return await this.addon.status();
    }
    getBackendInfo() {
        return this.addon?.getBackendInfo?.() ?? null;
    }
    async run(audio) {
        const addon = this._requiredAddon();
        this._pendingJobId = await addon.append({
            type: "audio",
            input: new Uint8Array(),
        });
        const response = this.ctx.job.start();
        const finalized = response.await();
        void finalized.catch(() => { });
        response.await = () => finalized;
        void this._pumpBatchAudio(audio).catch((error) => {
            this._pendingJobId = null;
            this.ctx.job.fail(error);
        });
        return response;
    }
    createStreamingSession(audio, opts = {}) {
        const vadModelPath = this._resolveVadModelPath();
        if (!vadModelPath) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.VAD_MODEL_REQUIRED,
            });
        }
        const streamingOpts = this._validateStreamingOptions(opts);
        const addon = this._requiredAddon();
        const streamingConfig = this._buildStreamingConfig(vadModelPath, streamingOpts);
        addon.startStreaming(streamingConfig);
        this._pendingJobId = null;
        const response = this.ctx.job.start();
        const finalized = response.await().finally(() => {
            addon.finishStreaming();
        });
        void finalized.catch(() => { });
        response.await = () => finalized;
        void this._pumpStreamingAudio(audio).catch((error) => {
            this._pendingJobId = null;
            this.ctx.job.fail(error);
        });
        return Promise.resolve({
            response,
            done: finalized.then(() => { }, () => { }),
        });
    }
    _validateStreamingOptions(opts) {
        for (const key of Object.keys(opts)) {
            if (!WHISPER_STREAMING_OPT_KEYS.includes(key)) {
                throw new error_1.QvacErrorAddonASRGgml({
                    code: error_1.ERR_CODES.INVALID_CONFIG,
                    adds: `${key} is not a valid whisper streaming option`,
                });
            }
        }
        return opts;
    }
    async _pumpBatchAudio(audio) {
        this.ctx.logger.debug("Start handling audio stream", {
            modelPath: this._files.model,
        });
        const addon = this._requiredAddon();
        for await (const chunk of audio) {
            // Teardown (cancel/unload/destroy/reload) runs on its own queue and can
            // pre-empt an in-flight run: once the job is gone there is nothing to
            // append to, and appending would hit a destroyed native instance.
            if (!this.ctx.job.active) {
                this.ctx.logger.debug("Job is no longer active; stopping audio pump");
                return;
            }
            this.ctx.logger.debug("Appending audio chunk", {
                chunkLength: chunk.length,
            });
            await addon.append({ type: "audio", input: bytesOf(chunk) });
        }
        if (!this.ctx.job.active)
            return;
        this.ctx.logger.debug("Sending end-of-input signal");
        await addon.append({ type: constants_1.END_OF_INPUT });
    }
    async _pumpStreamingAudio(audio) {
        this.ctx.logger.debug("Start handling streaming audio");
        const addon = this._requiredAddon();
        for await (const chunk of audio) {
            addon.appendStreamingAudio({ type: "audio", input: bytesOf(chunk) });
        }
        this.ctx.logger.debug("Ending streaming session");
        addon.endStreaming();
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
    /**
     * Maps the public `audio_format` config value onto the byte interpretation
     * applied to raw `Uint8Array` input. Unrecognized values are rejected here
     * rather than coerced: the wire format sent to native is pinned to f32le,
     * so the native `UnsupportedAudioFormat` check can no longer see the user's
     * string, and silently decoding (say) `'s16be'` as little-endian produces a
     * garbage transcript with no error at all.
     */
    _resolveByteFormat(overrideAudioFormat) {
        const format = overrideAudioFormat ||
            this._config.audio_format ||
            this.params.audio_format ||
            DEFAULT_BYTE_FORMAT;
        if (format === "f32le" || format === "decoded")
            return "f32le";
        if (format === "s16le")
            return "s16le";
        throw new error_1.QvacErrorAddonASRGgml({
            code: error_1.ERR_CODES.INVALID_AUDIO_FORMAT,
            adds: `${String(format)} — supported values are "s16le", "f32le" and "decoded"`,
        });
    }
    _buildConfigurationParams(overrides = {}) {
        this._byteFormat = this._resolveByteFormat(overrides.audio_format);
        return {
            engineType: "whisper",
            contextParams: {
                model: this._config.path || this._files.model,
                ...(this._config.contextParams || {}),
            },
            whisperConfig: this._buildWhisperConfig(overrides.whisperConfig || {}),
            miscConfig: overrides.miscConfig || {
                caption_enabled: false,
                ...(this._config.miscConfig || {}),
            },
            // The driver normalizes every input to f32 samples; the wire format
            // is pinned. The user-facing `audio_format` config key only selects
            // how raw Uint8Array bytes are interpreted at the JS boundary.
            audio_format: WIRE_AUDIO_FORMAT,
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
            streamingConfig.vadRunIntervalMs = streamingOpts.vadRunIntervalMs;
        }
        return streamingConfig;
    }
    _createAddon(configurationParams) {
        this.ctx.logger.info("Creating Whisper interface with configuration:", configurationParams);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("../../binding.js");
        return new whisper_1.WhisperInterface(binding, configurationParams, this._outputCallback.bind(this), this.ctx.logger.info.bind(this.ctx.logger));
    }
    _outputCallback(_addon, event, jobId, data, error) {
        if (event === "Error") {
            this.ctx.logger.error(`Job failed with error: ${String(error)}`);
            this._pendingJobId = null;
            this.ctx.job.fail(error);
            return;
        }
        if (event === "Output") {
            try {
                this.ctx.logger.debug(`Job produced output: ${dataAsString(data)}`);
            }
            catch (err) {
                this.ctx.logger.error(`Failed to serialize output for logging: ${errorMessage(err)}`);
                this.ctx.logger.debug("Job produced output: [non-serializable data]");
            }
            this.ctx.job.output(data);
            return;
        }
        if (event === "VadState") {
            this.ctx.logger.debug(`Job produced conversation event: ${dataAsString(data)}`);
            const payload = isRecord(data) ? data : {};
            this.ctx.job.output({
                type: "vad",
                speaking: Boolean(payload.speaking),
                score: typeof payload.probability === "number"
                    ? payload.probability
                    : 0,
                source: "silero",
            });
            return;
        }
        if (event === "EndOfTurn") {
            this.ctx.logger.debug(`Job produced conversation event: ${dataAsString(data)}`);
            const payload = isRecord(data) ? data : {};
            this.ctx.job.output({
                ...payload,
                type: "endOfTurn",
                source: "vad-silence",
            });
            return;
        }
        if (event === "JobEnded") {
            this.ctx.logger.info(`Job ${jobId} completed. Stats: ${JSON.stringify(data)}`);
            this._pendingJobId = null;
            if (this.ctx.enableStats)
                this.ctx.job.end(data);
            else
                this.ctx.job.end();
            return;
        }
        this.ctx.logger.debug(`Received event for job ${jobId}: ${event}`);
    }
    _requiredAddon() {
        if (!this.addon)
            throw new Error("Addon is not loaded");
        return this.addon;
    }
}
exports.WhisperDriver = WhisperDriver;
