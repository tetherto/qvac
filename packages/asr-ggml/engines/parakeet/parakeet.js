"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParakeetInterface = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
const path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
const error_1 = require("../../lib/error");
const constants_1 = require("../../lib/constants");
const audio_1 = require("../../lib/audio");
const state = Object.freeze({
    LOADING: "loading",
    LISTENING: "listening",
    PROCESSING: "processing",
    IDLE: "idle",
    PAUSED: "paused",
    STOPPED: "stopped",
});
function nextSafeId(current) {
    return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}
function normalizeError(error) {
    if (error instanceof Error) {
        return { message: error.message, cause: error };
    }
    if (error && typeof error === "object" && "message" in error) {
        const message = error.message;
        if (typeof message === "string" && message) {
            return { message, cause: new Error(message) };
        }
    }
    const message = typeof error === "string" ? error : "unknown error";
    return { message, cause: new Error(message) };
}
function createParakeetError(code, message, error) {
    const cause = error === undefined ? undefined : normalizeError(error).cause;
    return new error_1.QvacErrorAddonASRGgml({ code, adds: message, cause });
}
/**
 * Low-level interface between the Bare addon (C++) and the JavaScript runtime.
 * The model type is auto-detected from the loaded GGUF metadata.
 */
class ParakeetInterface {
    _binding;
    _outputCallback;
    _stateCallback;
    _handle;
    _state;
    _nextJobId;
    _activeJobId;
    _onCancelComplete;
    _bufferedAudio;
    _bufferedBytes;
    _config;
    constructor(binding, configurationParams, outputCallback, stateCallback = null) {
        this._binding = binding;
        this._outputCallback = outputCallback;
        this._stateCallback = stateCallback;
        this._handle = null;
        this._state = state.LOADING;
        this._nextJobId = 1;
        this._activeJobId = null;
        this._onCancelComplete = null;
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        this._config = this._applyDefaults(configurationParams);
        this._createNativeInstance(this._config);
    }
    _applyDefaults(configurationParams) {
        const out = { ...configurationParams };
        if (!out.backendsDir) {
            // Generated file lives at engines/parakeet/parakeet.js; prebuilds/
            // sits at the package root, two levels up.
            out.backendsDir = path.join(__dirname, "..", "..", "prebuilds");
        }
        return out;
    }
    _setState(newState) {
        this._state = newState;
        if (this._stateCallback) {
            this._stateCallback(this, newState);
        }
    }
    _createNativeInstance(configurationParams) {
        this._config = configurationParams;
        this._activeJobId = null;
        this._onCancelComplete = null;
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        this._handle = this._binding.createInstance(this, this._config, this._addonOutputCallback.bind(this), this._stateCallback);
    }
    _looksLikeStats(data) {
        return (data !== null &&
            typeof data === "object" &&
            ("totalTime" in data ||
                "audioDurationMs" in data ||
                "totalSamples" in data));
    }
    _looksLikeTranscript(data) {
        return (Array.isArray(data) ||
            (data !== null &&
                typeof data === "object" &&
                "text" in data &&
                typeof data.text === "string"));
    }
    _mapAddonEvent(event, data, isError) {
        const eventStr = typeof event === "string" ? event : String(event);
        if (eventStr === "Error" ||
            eventStr === "JobEnded" ||
            eventStr === "Output") {
            return eventStr;
        }
        if (isError || eventStr.includes("Error"))
            return "Error";
        if (eventStr.includes("RuntimeStats"))
            return "JobEnded";
        if (eventStr.includes("Output"))
            return "Output";
        if (this._looksLikeStats(data))
            return "JobEnded";
        if (this._looksLikeTranscript(data))
            return "Output";
        return event;
    }
    _resolvePendingCancel() {
        if (!this._onCancelComplete)
            return false;
        const resolve = this._onCancelComplete;
        this._onCancelComplete = null;
        resolve();
        return true;
    }
    _addonOutputCallback(addon, event, data, error) {
        const isError = typeof error === "string" && error.length > 0;
        const mappedEvent = this._mapAddonEvent(event, data, isError);
        const isTerminal = mappedEvent === "Error" || mappedEvent === "JobEnded";
        const jobId = this._activeJobId;
        if (jobId === null) {
            if (isTerminal)
                this._resolvePendingCancel();
            return;
        }
        if (isTerminal && this._resolvePendingCancel())
            return;
        if (mappedEvent === "Output")
            this._setState(state.PROCESSING);
        this._outputCallback(addon, mappedEvent, jobId, data, isError ? error : null);
        if (isTerminal) {
            this._activeJobId = null;
            this._setState(state.LISTENING);
        }
    }
    _emitSyntheticError(jobId, error) {
        this._outputCallback(this, "Error", jobId, undefined, error);
    }
    async loadWeights(weightsData) {
        try {
            return await this._binding.loadWeights(this._handle, weightsData);
        }
        catch (error) {
            const normalized = normalizeError(error);
            throw createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_LOAD_WEIGHTS, normalized.message, error);
        }
    }
    activate() {
        try {
            this._binding.activate(this._handle);
            this._setState(state.LISTENING);
            return Promise.resolve();
        }
        catch (error) {
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_ACTIVATE, normalized.message, error));
        }
    }
    getBackendInfo() {
        if (this._handle === null)
            return null;
        return this._binding.getBackendInfo(this._handle);
    }
    append(data) {
        try {
            if (data?.type === constants_1.END_OF_INPUT) {
                return Promise.resolve(this._submitBufferedJob());
            }
            if (data?.type === "audio") {
                return Promise.resolve(this._bufferAudioChunk(data.data));
            }
            const inputType = data?.type;
            throw new Error(`Unknown append input type: ${String(inputType)}`);
        }
        catch (error) {
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_APPEND, normalized.message, error));
        }
    }
    _submitBufferedJob() {
        const currentJobId = this._nextJobId;
        const input = this._concatBufferedAudio();
        const previousState = this._state;
        let accepted = false;
        try {
            accepted = this._binding.runJob(this._handle, { type: "audio", input });
        }
        catch (error) {
            this._setState(previousState);
            throw error;
        }
        if (!accepted) {
            this._setState(previousState);
            throw new Error("Cannot set new job: a job is already set or being processed");
        }
        this._activeJobId = currentJobId;
        this._nextJobId = nextSafeId(this._nextJobId);
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        this._setState(state.PROCESSING);
        return currentJobId;
    }
    _bufferAudioChunk(rawData) {
        const normalized = this._normalizeAudioInput(rawData);
        if (this._bufferedBytes + normalized.byteLength > constants_1.MAX_BUFFERED_BYTES) {
            throw createParakeetError(error_1.ERR_CODES_PARAKEET.BUFFER_LIMIT_EXCEEDED, constants_1.MAX_BUFFERED_BYTES + " bytes");
        }
        this._bufferedAudio.push(normalized);
        this._bufferedBytes += normalized.byteLength;
        return this._nextJobId;
    }
    status() {
        try {
            return Promise.resolve(this._state);
        }
        catch (error) {
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_GET_STATUS, normalized.message, error));
        }
    }
    pause() {
        try {
            this._setState(state.PAUSED);
            return Promise.resolve();
        }
        catch (error) {
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_PAUSE, normalized.message, error));
        }
    }
    async stop() {
        try {
            this._bufferedAudio = [];
            this._bufferedBytes = 0;
            if (this._activeJobId !== null) {
                const cancelComplete = new Promise((resolve) => {
                    this._onCancelComplete = resolve;
                });
                this._activeJobId = null;
                await this._binding.cancel(this._handle);
                await cancelComplete;
            }
            this._setState(state.STOPPED);
        }
        catch (error) {
            const normalized = normalizeError(error);
            throw createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_RESET, normalized.message, error);
        }
    }
    async cancel(jobId) {
        try {
            const pendingJobId = this._bufferedAudio.length > 0 ? this._nextJobId : null;
            const targetJobId = jobId ?? this._activeJobId ?? pendingJobId;
            if (targetJobId === null) {
                this._bufferedAudio = [];
                this._bufferedBytes = 0;
                this._setState(state.LISTENING);
                return;
            }
            if (this._activeJobId === targetJobId) {
                const cancelComplete = new Promise((resolve) => {
                    this._onCancelComplete = resolve;
                });
                await this._binding.cancel(this._handle);
                await cancelComplete;
                this._bufferedAudio = [];
                this._bufferedBytes = 0;
                this._activeJobId = null;
                this._setState(state.LISTENING);
                return;
            }
            if (this._activeJobId === null && pendingJobId === targetJobId) {
                this._bufferedAudio = [];
                this._bufferedBytes = 0;
                this._setState(state.LISTENING);
                this._emitSyntheticError(targetJobId, "Job cancelled");
            }
        }
        catch (error) {
            const normalized = normalizeError(error);
            throw createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_CANCEL, normalized.message, error);
        }
    }
    async reload(configurationParams) {
        try {
            await this.cancel();
            await this.destroyInstance();
            this._createNativeInstance(configurationParams);
            this._setState(state.LOADING);
        }
        catch (error) {
            const normalized = normalizeError(error);
            throw createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_RESET, normalized.message, error);
        }
    }
    unloadWeights() {
        return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_RESET, "unloadWeights is not supported by this package. Use unload() or destroyInstance()."));
    }
    async load(configurationParams) {
        try {
            await this.destroyInstance();
            this._createNativeInstance(configurationParams);
            this._setState(state.LOADING);
        }
        catch (error) {
            const normalized = normalizeError(error);
            throw createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_RESET, normalized.message, error);
        }
    }
    async unload() {
        await this.destroyInstance();
    }
    async destroyInstance() {
        try {
            if (this._handle === null)
                return;
            if (this._activeJobId !== null) {
                try {
                    await this._binding.cancel(this._handle);
                }
                catch { }
            }
            this._binding.destroyInstance(this._handle);
            this._handle = null;
            this._activeJobId = null;
            this._bufferedAudio = [];
            this._bufferedBytes = 0;
            this._setState(state.IDLE);
        }
        catch (error) {
            const normalized = normalizeError(error);
            throw createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_DESTROY, normalized.message, error);
        }
    }
    runJob(data) {
        const currentJobId = this._nextJobId;
        const previousJobId = this._activeJobId;
        const previousState = this._state;
        try {
            const accepted = this._binding.runJob(this._handle, data);
            if (!accepted) {
                this._activeJobId = previousJobId;
                this._setState(previousState);
                return Promise.resolve(false);
            }
            this._activeJobId = currentJobId;
            this._nextJobId = nextSafeId(this._nextJobId);
            this._setState(state.PROCESSING);
            return Promise.resolve(accepted);
        }
        catch (error) {
            this._activeJobId = previousJobId;
            this._setState(previousState);
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_APPEND, normalized.message, error));
        }
    }
    startStreaming(config = {}) {
        try {
            if (this._activeJobId !== null) {
                throw new Error("Cannot start streaming: a job is already active. Call cancel() first.");
            }
            const currentJobId = this._nextJobId;
            this._activeJobId = currentJobId;
            this._nextJobId = nextSafeId(this._nextJobId);
            try {
                this._binding.startStreaming(this._handle, config);
            }
            catch (error) {
                this._activeJobId = null;
                throw error;
            }
            this._setState(state.PROCESSING);
            return Promise.resolve(currentJobId);
        }
        catch (error) {
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_APPEND, normalized.message, error));
        }
    }
    appendStreamingAudio(data) {
        try {
            if (this._activeJobId === null) {
                throw new Error("No active streaming session; call startStreaming() first.");
            }
            const samples = this._normalizeAudioInput(data);
            return Promise.resolve(this._binding.appendStreamingAudio(this._handle, {
                type: "audio",
                input: samples,
            }));
        }
        catch (error) {
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_APPEND, normalized.message, error));
        }
    }
    endStreaming() {
        try {
            if (this._activeJobId === null)
                return Promise.resolve();
            const jobId = this._activeJobId;
            const teardown = this._binding.endStreaming(this._handle) || {};
            this._activeJobId = null;
            this._setState(state.LISTENING);
            this._outputCallback(this, "JobEnded", jobId, {
                totalTime: 0,
                audioDurationMs: typeof teardown.audioDurationMs === "number"
                    ? teardown.audioDurationMs
                    : 0,
                totalSamples: typeof teardown.totalSamples === "number"
                    ? teardown.totalSamples
                    : 0,
            }, null);
            return Promise.resolve();
        }
        catch (error) {
            const normalized = normalizeError(error);
            return Promise.reject(createParakeetError(error_1.ERR_CODES_PARAKEET.FAILED_TO_RESET, normalized.message, error));
        }
    }
    async cancelStreaming() {
        return this.cancel();
    }
    _normalizeAudioInput(data) {
        if (!data)
            throw new Error("Audio input is required");
        if (data instanceof Float32Array)
            return data;
        if (ArrayBuffer.isView(data)) {
            if (data instanceof Int16Array)
                return (0, audio_1.pcmS16ToFloat32)(data);
            return new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
        }
        if (data instanceof ArrayBuffer)
            return new Float32Array(data);
        throw new Error("Unsupported audio input format");
    }
    _concatBufferedAudio() {
        if (this._bufferedAudio.length === 0)
            return new Float32Array(0);
        if (this._bufferedAudio.length === 1)
            return this._bufferedAudio[0];
        return (0, audio_1.mergeFloat32Chunks)(this._bufferedAudio);
    }
}
exports.ParakeetInterface = ParakeetInterface;
