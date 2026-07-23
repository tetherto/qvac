"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const parakeet_1 = require("./parakeet");
const error_1 = require("./lib/error");
const audio_1 = require("./lib/audio");
/**
 * High-level Parakeet speech-to-text client backed by qvac-parakeet.cpp.
 * Accepts CTC, TDT, EOU, and Sortformer GGUF checkpoints; model type is
 * auto-detected from GGUF metadata.
 */
class TranscriptionParakeet {
    logger;
    exclusiveRun;
    state;
    addon;
    params;
    _config;
    _runQueueWaiter;
    _job;
    constructor({ files = {}, config = {}, logger = undefined, exclusiveRun = true, }) {
        this.logger = new QvacLogger(logger);
        this.exclusiveRun = !!exclusiveRun;
        this._runQueueWaiter = Promise.resolve();
        this.state = {
            configLoaded: false,
            weightsLoaded: false,
            destroyed: false,
        };
        this._config = { ...config, modelPath: files.model };
        this.params = config.parakeetConfig || {};
        this._job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
        this.logger.debug("TranscriptionParakeet constructor called", {
            params: this.params,
            config: this._config,
        });
        this.validateModelFiles();
    }
    validateModelFiles() {
        const modelPath = this._config.modelPath;
        if (modelPath && !fs.existsSync(modelPath)) {
            this.logger.warn("Model file not found", { path: modelPath });
        }
    }
    _buildConfigurationParams() {
        return {
            modelPath: this._config.modelPath || "",
            maxThreads: this.params.maxThreads ?? 4,
            useGPU: this.params.useGPU === true,
            sampleRate: this.params.sampleRate || 16000,
            channels: this.params.channels || 1,
            captionEnabled: this.params.captionEnabled === true,
            timestampsEnabled: this.params.timestampsEnabled !== false,
            seed: this.params.seed ?? -1,
            streaming: this.params.streaming === true,
            streamingChunkMs: this.params.streamingChunkMs ?? 2000,
            streamingHistoryMs: this.params.streamingHistoryMs ?? 30000,
            streamingEmitPartials: this.params.streamingEmitPartials !== false,
            streamingEnergyVad: this.params.streamingEnergyVad === true,
            streamingLeftContextMs: this.params.streamingLeftContextMs ?? -1,
            streamingRightLookaheadMs: this.params.streamingRightLookaheadMs ?? -1,
            streamingSpkCacheEnable: this.params.streamingSpkCacheEnable !== false,
            streamingSpkCacheLen: this.params.streamingSpkCacheLen,
            streamingFifoLen: this.params.streamingFifoLen,
            streamingChunkLeftContextMs: this.params.streamingChunkLeftContextMs,
            streamingChunkRightContextMs: this.params.streamingChunkRightContextMs,
            streamingSpkCacheUpdatePeriod: this.params.streamingSpkCacheUpdatePeriod,
            backendsDir: this.params.backendsDir,
            openclCacheDir: this.params.openclCacheDir,
        };
    }
    getState() {
        return this.state;
    }
    async load() {
        if (this.state.destroyed) {
            throw new error_1.QvacErrorAddonParakeet(error_1.ERR_CODES.INSTANCE_DESTROYED);
        }
        if (this.state.configLoaded || this.state.weightsLoaded) {
            this.logger.info("Reload requested - unloading existing model first");
            await this.unload();
        }
        await this._load();
        this.state.configLoaded = true;
        this.state.weightsLoaded = true;
    }
    async run(audioStream) {
        const input = audioStream;
        if (this.exclusiveRun) {
            return this._withExclusiveRun(() => this._runInternal(input));
        }
        return this._runInternal(input);
    }
    /**
     * Opens a long-lived native streaming session and forwards chunks as they
     * arrive. Segment updates surface through `response.onUpdate(...)`.
     */
    async runStreaming(audioStream, streamingConfig = {}) {
        const input = audioStream;
        if (this.exclusiveRun) {
            return this._withExclusiveRun(() => this._runStreamingInternal(input, streamingConfig));
        }
        return this._runStreamingInternal(input, streamingConfig);
    }
    async _withExclusiveRun(fn) {
        const prev = this._runQueueWaiter;
        let release = () => { };
        this._runQueueWaiter = new Promise((resolve) => {
            release = resolve;
        });
        await prev;
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
    async _load() {
        const configurationParams = this._buildConfigurationParams();
        this.logger.info("Creating Parakeet addon with configuration:", configurationParams);
        this.addon = this._createAddon(configurationParams);
        await this.addon.activate();
        this.logger.debug("Addon activated");
    }
    _runInternal(audioStream) {
        const response = this._job.start();
        let normalized;
        try {
            normalized = this._normalizeAudioStream(audioStream);
        }
        catch (error) {
            this._job.fail(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        void this._handleAudioStream(normalized).catch((error) => {
            this._job.fail(error instanceof Error ? error : new Error(String(error)));
        });
        return Promise.resolve(response);
    }
    async _runStreamingInternal(audioStream, streamingConfig) {
        const normalized = this._normalizeAudioStream(audioStream);
        const addon = this._requireAddon();
        const response = this._job.start();
        try {
            await addon.startStreaming(streamingConfig || {});
        }
        catch (error) {
            this._job.fail(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        void this._pumpStreamingAudio(normalized).catch((error) => {
            void addon.endStreaming().catch(() => { });
            this._job.fail(error instanceof Error ? error : new Error(String(error)));
        });
        return response;
    }
    async _pumpStreamingAudio(audioStream) {
        const addon = this._requireAddon();
        this.logger.debug("Start pumping audio into duplex streaming session");
        for await (const chunk of audioStream) {
            const audioData = (0, audio_1.toFloat32Chunk)(chunk);
            if (audioData.length === 0)
                continue;
            await addon.appendStreamingAudio(audioData);
        }
        this.logger.debug("Audio stream completed; closing duplex streaming session");
        await addon.endStreaming();
    }
    async _handleAudioStream(audioStream) {
        const addon = this._requireAddon();
        this.logger.debug("Start handling audio stream");
        for await (const chunk of audioStream) {
            this.logger.debug("Appending audio chunk", {
                chunkLength: chunk.length,
            });
            const audioData = (0, audio_1.toFloat32Chunk)(chunk);
            await addon.append({ type: "audio", data: audioData.buffer });
        }
        this.logger.debug("Sending end-of-input signal");
        await addon.append({ type: error_1.END_OF_INPUT });
    }
    _normalizeAudioStream(audioStream) {
        if (!audioStream)
            throw new Error("audioStream is required");
        if (typeof audioStream[Symbol.asyncIterator] === "function") {
            return audioStream;
        }
        if (audioStream instanceof Uint8Array ||
            audioStream instanceof Float32Array) {
            return [audioStream];
        }
        if (Array.isArray(audioStream)) {
            return audioStream;
        }
        if (typeof audioStream[Symbol.iterator] === "function") {
            return [Uint8Array.from(audioStream)];
        }
        throw new Error("Unsupported audio input. Expected stream, TypedArray, or chunk array.");
    }
    _outputCallback(_addon, event, _jobId, data, error) {
        if (event === "Error") {
            this._job.fail(error instanceof Error ? error : new Error(String(error)));
        }
        else if (event === "Output") {
            this._job.output(data);
        }
        else if (event === "JobEnded") {
            this._job.end(data);
        }
    }
    async reload(newConfig = {}) {
        return this._withExclusiveRun(async () => {
            this.logger.debug("Reloading addon with new configuration", newConfig);
            if (newConfig.parakeetConfig) {
                this.params = { ...this.params, ...newConfig.parakeetConfig };
            }
            const configurationParams = this._buildConfigurationParams();
            await this.cancel();
            this._job.fail(new Error("Model was reloaded"));
            const addon = this._requireAddon();
            await addon.reload(configurationParams);
            await addon.activate();
            this.logger.debug("Addon reloaded and activated successfully");
        });
    }
    _createAddon(configurationParams) {
        this.logger.info("Creating Parakeet interface with configuration:", configurationParams);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        return new parakeet_1.ParakeetInterface(binding, configurationParams, this._outputCallback.bind(this), this.logger.info.bind(this.logger));
    }
    async unload() {
        return this._withExclusiveRun(async () => {
            await this.cancel();
            this._job.fail(new Error("Model was unloaded"));
            if (this.addon)
                await this.addon.destroyInstance();
            this.state.configLoaded = false;
            this.state.weightsLoaded = false;
        });
    }
    async cancel(jobId) {
        if (this.addon?.cancel)
            await this.addon.cancel(jobId);
        if (this._job.active) {
            this._job.fail(new error_1.QvacErrorAddonParakeet(error_1.ERR_CODES.JOB_CANCELLED));
        }
    }
    async status() {
        return this.addon?.status();
    }
    getBackendInfo() {
        return this.addon?.getBackendInfo?.() ?? null;
    }
    async pause() {
        await this.addon?.pause();
    }
    async unpause() {
        await this.addon?.activate();
    }
    async destroy() {
        return this._withExclusiveRun(async () => {
            await this.cancel();
            this._job.fail(new Error("Model was destroyed"));
            if (this.addon)
                await this.addon.destroyInstance();
            this.state.configLoaded = false;
            this.state.destroyed = true;
        });
    }
    _requireAddon() {
        if (!this.addon) {
            throw new Error("Parakeet addon is not loaded");
        }
        return this.addon;
    }
}
// eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging preserves the package's established class namespace API.
(function (TranscriptionParakeet) {
    /**
     * Numeric code identifying the compute backend selected by the engine.
     */
    let BackendId;
    (function (BackendId) {
        BackendId[BackendId["CPU"] = 0] = "CPU";
        BackendId[BackendId["Metal"] = 1] = "Metal";
        BackendId[BackendId["CUDA"] = 2] = "CUDA";
        BackendId[BackendId["Vulkan"] = 3] = "Vulkan";
        BackendId[BackendId["OpenCL"] = 4] = "OpenCL";
        BackendId[BackendId["Other"] = 99] = "Other";
    })(BackendId = TranscriptionParakeet.BackendId || (TranscriptionParakeet.BackendId = {}));
})(TranscriptionParakeet || (TranscriptionParakeet = {}));
module.exports = TranscriptionParakeet;
