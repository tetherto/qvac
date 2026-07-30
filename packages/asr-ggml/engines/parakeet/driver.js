"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParakeetDriver = void 0;
const parakeet_1 = require("./parakeet");
const error_1 = require("../../lib/error");
const constants_1 = require("../../lib/constants");
const audio_1 = require("../../lib/audio");
const PARAKEET_CONFIG_KEYS = [
    "maxThreads",
    "useGPU",
    "sampleRate",
    "channels",
    "captionEnabled",
    "timestampsEnabled",
    "seed",
    "streaming",
    "streamingChunkMs",
    "streamingHistoryMs",
    "streamingEmitPartials",
    "streamingEnergyVad",
    "streamingLeftContextMs",
    "streamingRightLookaheadMs",
    "streamingSpkCacheEnable",
    "streamingSpkCacheLen",
    "streamingFifoLen",
    "streamingChunkLeftContextMs",
    "streamingChunkRightContextMs",
    "streamingSpkCacheUpdatePeriod",
    "backendsDir",
    "openclCacheDir",
];
const PARAKEET_STREAMING_OPT_KEYS = [
    "chunkMs",
    "historyMs",
    "leftContextMs",
    "rightLookaheadMs",
    "emitPartials",
    "emitEnergyVad",
    "spkCacheEnable",
    "spkCacheLen",
    "fifoLen",
    "chunkLeftContextMs",
    "chunkRightContextMs",
    "spkCacheUpdatePeriod",
];
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object";
}
/**
 * Returns the (last) transcription segment of an output payload, or null
 * when the payload is not segment-shaped.
 */
function lastSegmentOf(data) {
    const candidate = Array.isArray(data)
        ? data[data.length - 1]
        : data;
    if (isRecord(candidate) && typeof candidate.text === "string") {
        return candidate;
    }
    return null;
}
/**
 * Returns an ArrayBuffer covering exactly the chunk's samples. Guards
 * against Float32Array views whose backing buffer is larger than the view.
 */
function chunkBuffer(chunk) {
    if (chunk.byteOffset === 0 &&
        chunk.byteLength === chunk.buffer.byteLength) {
        return chunk.buffer;
    }
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
}
/**
 * Parakeet engine driver: owns the `ParakeetInterface`, the parakeet event
 * mapping, and the parakeet streaming lifecycle. Backed by
 * qvac-parakeet.cpp; accepts CTC, TDT, EOU, and Sortformer GGUF
 * checkpoints.
 */
class ParakeetDriver {
    engineType = "parakeet";
    supportsReload = true;
    addon;
    params;
    ctx;
    _files;
    constructor(ctx, files, config) {
        this.ctx = ctx;
        this._files = { model: files.model };
        this.params = config.parakeetConfig || {};
    }
    validateConfig() {
        for (const key of Object.keys(this.params)) {
            if (!PARAKEET_CONFIG_KEYS.includes(key)) {
                throw new error_1.QvacErrorAddonASRGgml({
                    code: error_1.ERR_CODES_PARAKEET.INVALID_CONFIG,
                    adds: `${key} is not a valid parameter for parakeetConfig`,
                });
            }
        }
    }
    normalizeAudio(input) {
        return (0, audio_1.normalizeAudioStream)(input, "s16le");
    }
    async load() {
        const configurationParams = this._buildConfigurationParams();
        this.ctx.logger.info("Creating Parakeet addon with configuration:", configurationParams);
        this.addon = this._createAddon(configurationParams);
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
        if (overrides.parakeetConfig) {
            this.params = { ...this.params, ...overrides.parakeetConfig };
        }
        const configurationParams = this._buildConfigurationParams();
        await this.cancelActive();
        if (this.ctx.job.active) {
            this.ctx.job.fail(new Error("Model was reloaded"));
        }
        const addon = this._requireAddon();
        await addon.reload(configurationParams);
        await addon.activate();
        this.ctx.logger.debug("Addon reloaded and activated successfully");
    }
    async cancelActive(jobId) {
        if (this.addon?.cancel)
            await this.addon.cancel(jobId);
        if (this.ctx.job.active) {
            this.ctx.job.fail(new error_1.QvacErrorAddonASRGgml(error_1.ERR_CODES_PARAKEET.JOB_CANCELLED));
        }
    }
    async status() {
        if (!this.addon?.status) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES_PARAKEET.FAILED_TO_GET_STATUS,
                adds: "addon is not loaded",
            });
        }
        return await this.addon.status();
    }
    getBackendInfo() {
        return this.addon?.getBackendInfo?.() ?? null;
    }
    run(audio) {
        const response = this.ctx.job.start();
        void this._pumpBatchAudio(audio).catch((error) => {
            this.ctx.job.fail(asError(error));
        });
        return Promise.resolve(response);
    }
    async createStreamingSession(audio, opts = {}) {
        const streamingOpts = this._validateStreamingOptions(opts);
        const addon = this._requireAddon();
        const response = this.ctx.job.start();
        try {
            await addon.startStreaming(streamingOpts);
        }
        catch (error) {
            this.ctx.job.fail(asError(error));
            throw error;
        }
        void this._pumpStreamingAudio(audio).catch((error) => {
            void this.addon?.endStreaming().catch(() => { });
            this.ctx.job.fail(asError(error));
        });
        // `endStreaming` already resets the interface state, so settlement of
        // the response is the end of driver teardown.
        const done = response.await().then(() => { }, () => { });
        return { response, done };
    }
    _validateStreamingOptions(opts) {
        for (const key of Object.keys(opts)) {
            if (!PARAKEET_STREAMING_OPT_KEYS.includes(key)) {
                throw new error_1.QvacErrorAddonASRGgml({
                    code: error_1.ERR_CODES_PARAKEET.INVALID_CONFIG,
                    adds: `${key} is not a valid parakeet streaming option`,
                });
            }
        }
        return opts;
    }
    async _pumpBatchAudio(audio) {
        const addon = this._requireAddon();
        this.ctx.logger.debug("Start handling audio stream");
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
            await addon.append({ type: "audio", data: chunkBuffer(chunk) });
        }
        if (!this.ctx.job.active)
            return;
        this.ctx.logger.debug("Sending end-of-input signal");
        await addon.append({ type: constants_1.END_OF_INPUT });
    }
    async _pumpStreamingAudio(audio) {
        const addon = this._requireAddon();
        this.ctx.logger.debug("Start pumping audio into duplex streaming session");
        for await (const chunk of audio) {
            if (chunk.length === 0)
                continue;
            await addon.appendStreamingAudio(chunk);
        }
        this.ctx.logger.debug("Audio stream completed; closing duplex streaming session");
        await addon.endStreaming();
    }
    _buildConfigurationParams() {
        return {
            engineType: "parakeet",
            modelPath: this._files.model || "",
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
    _createAddon(configurationParams) {
        this.ctx.logger.info("Creating Parakeet interface with configuration:", configurationParams);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("../../binding.js");
        return new parakeet_1.ParakeetInterface(binding, configurationParams, this._outputCallback.bind(this), this.ctx.logger.info.bind(this.ctx.logger));
    }
    _outputCallback(_addon, event, _jobId, data, error) {
        if (event === "Error") {
            this.ctx.job.fail(asError(error));
            return;
        }
        if (event === "Output") {
            // The segment payload passes through untouched; a typed endOfTurn
            // event is additionally synthesized when the (last) segment carries
            // the model's end-of-utterance flag (double-signal).
            this.ctx.job.output(data);
            const segment = lastSegmentOf(data);
            if (segment?.isEndOfTurn === true) {
                this.ctx.job.output({ type: "endOfTurn", source: "model-eou" });
            }
            return;
        }
        if (event === "JobEnded") {
            if (this.ctx.enableStats)
                this.ctx.job.end(data);
            else
                this.ctx.job.end();
        }
    }
    _requireAddon() {
        if (!this.addon) {
            throw new Error("Parakeet addon is not loaded");
        }
        return this.addon;
    }
}
exports.ParakeetDriver = ParakeetDriver;
