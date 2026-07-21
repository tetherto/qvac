"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhisperInterface = void 0;
/* eslint-disable @typescript-eslint/require-await -- low-level methods intentionally retain their established Promise-based API around synchronous native calls. */
const configChecker_1 = require("./configChecker");
const error_1 = require("./lib/error");
const state = Object.freeze({
    LOADING: "loading",
    LISTENING: "listening",
    PROCESSING: "processing",
    IDLE: "idle",
    PAUSED: "paused",
    STOPPED: "stopped",
});
const END_OF_INPUT = "end of job";
const MAX_BUFFERED_BYTES = 500 * 1024 * 1024;
function nextSafeId(current) {
    return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
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
function isErrorString(error) {
    return typeof error === "string" && error.length > 0;
}
function isRecord(data) {
    return Boolean(data) && typeof data === "object";
}
function isStatsPayload(data) {
    return (isRecord(data) &&
        ("totalTime" in data ||
            "audioDurationMs" in data ||
            "totalSamples" in data));
}
function isVadPayload(data) {
    return isRecord(data) && data.type === "vad";
}
function isEndOfTurnPayload(data) {
    return isRecord(data) && data.type === "endOfTurn";
}
function isTranscriptPayload(data) {
    return ((Array.isArray(data) && data.length > 0) ||
        (isRecord(data) && typeof data.text === "string"));
}
function classifyEvent(event, data, error) {
    if (isVadPayload(data))
        return "VadState";
    if (isEndOfTurnPayload(data))
        return "EndOfTurn";
    if (event === "Error" ||
        isErrorString(error) ||
        String(event).includes("Error")) {
        return "Error";
    }
    if (event === "JobEnded" ||
        isStatsPayload(data) ||
        String(event).includes("RuntimeStats")) {
        return "JobEnded";
    }
    if (event === "Output" || isTranscriptPayload(data))
        return "Output";
    if (Array.isArray(data) && data.length === 0)
        return null;
    return String(event);
}
class WhisperInterface {
    _binding;
    _outputCb;
    _transitionCb;
    _nextJobId;
    _activeJobId;
    _bufferedAudio;
    _bufferedBytes;
    _state;
    _audioFormat;
    _handle;
    constructor(binding, configurationParams, outputCb, transitionCb = null) {
        this._binding = binding;
        this._outputCb = outputCb;
        this._transitionCb = transitionCb;
        this._nextJobId = 1;
        this._activeJobId = null;
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        this._state = state.LOADING;
        this._audioFormat = configurationParams?.audio_format || "s16le";
        (0, configChecker_1.checkConfig)(configurationParams);
        this._handle = this._binding.createInstance(this, configurationParams, this._addonOutputCallback.bind(this), transitionCb);
    }
    _setState(newState) {
        this._state = newState;
        if (this._transitionCb)
            this._transitionCb(this, newState);
    }
    _addonOutputCallback(addon, event, data, error) {
        const mappedEvent = classifyEvent(event, data, error);
        if (mappedEvent === null)
            return;
        const jobId = this._activeJobId;
        if (jobId === null)
            return;
        if (mappedEvent === "Output") {
            this._setState(state.PROCESSING);
            if (this._outputCb)
                this._emitTranscript(addon, jobId, data);
            return;
        }
        if (this._outputCb) {
            this._outputCb(addon, mappedEvent, jobId, data, isErrorString(error) ? error : null);
        }
        if (mappedEvent === "Error" || mappedEvent === "JobEnded") {
            this._activeJobId = null;
            this._setState(state.LISTENING);
        }
    }
    _emitTranscript(addon, jobId, data) {
        const isTranscriptArray = Array.isArray(data) &&
            data.length > 0 &&
            isRecord(data[0]) &&
            typeof data[0].text === "string";
        const isSingleTranscript = !Array.isArray(data) &&
            isRecord(data) &&
            typeof data.text === "string";
        if (isTranscriptArray) {
            this._emitSegments(addon, jobId, data);
            return;
        }
        if (isSingleTranscript) {
            this._outputCb?.(addon, "Output", jobId, [data], null);
            return;
        }
        this._outputCb?.(addon, "Output", jobId, data, null);
    }
    _emitSegments(addon, jobId, segments) {
        for (const segment of segments) {
            this._outputCb?.(addon, "Output", jobId, [segment], null);
        }
    }
    _emitSyntheticError(jobId, error) {
        if (!this._outputCb)
            return;
        this._outputCb(this, "Error", jobId, undefined, error);
    }
    async unload() {
        await this.destroyInstance();
    }
    async load(configurationParams) {
        (0, configChecker_1.checkConfig)(configurationParams);
        this._audioFormat =
            configurationParams?.audio_format || this._audioFormat;
        await this.destroyInstance();
        this._handle = this._binding.createInstance(this, configurationParams, this._addonOutputCallback.bind(this), this._transitionCb);
        this._setState(state.LOADING);
    }
    async reload(configurationParams) {
        (0, configChecker_1.checkConfig)(configurationParams);
        this._audioFormat =
            configurationParams?.audio_format || this._audioFormat;
        await this.cancel();
        if (typeof this._binding.reload === "function") {
            await this._binding.reload(this._requiredHandle(), configurationParams);
            this._setState(state.LOADING);
            return;
        }
        await this.load(configurationParams);
    }
    async loadWeights(weightsData) {
        try {
            this._binding.loadWeights(this._requiredHandle(), weightsData);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    async unloadWeights() {
        return true;
    }
    async activate() {
        try {
            this._binding.activate(this._requiredHandle());
            this._setState(state.LISTENING);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_ACTIVATE,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    async pause() {
        throw new error_1.QvacErrorAddonWhisper({
            code: error_1.ERR_CODES.FAILED_TO_PAUSE,
            adds: "pause is not supported in runJob mode",
        });
    }
    async stop() {
        throw new error_1.QvacErrorAddonWhisper({
            code: error_1.ERR_CODES.FAILED_TO_RESET,
            adds: "stop is not supported in runJob mode",
        });
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
                await this._binding.cancel(this._requiredHandle());
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
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_CANCEL,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    async append(data) {
        try {
            if (data?.type === END_OF_INPUT) {
                const currentJobId = this._nextJobId;
                const input = this._drainBufferedAudio();
                const previousJobId = this._activeJobId;
                const previousState = this._state;
                let accepted = false;
                try {
                    accepted = this._binding.runJob(this._requiredHandle(), {
                        type: "audio",
                        input,
                        audio_format: this._audioFormat,
                    });
                }
                catch (err) {
                    this._activeJobId = previousJobId;
                    this._setState(previousState);
                    throw err;
                }
                if (!accepted) {
                    this._activeJobId = previousJobId;
                    this._setState(previousState);
                    throw new Error("Cannot set new job: a job is already set or being processed");
                }
                this._activeJobId = currentJobId;
                this._nextJobId = nextSafeId(this._nextJobId);
                this._setState(state.PROCESSING);
                return currentJobId;
            }
            if (data?.type === "audio") {
                if (!(data.input instanceof Uint8Array)) {
                    throw new Error("Audio input must be Uint8Array");
                }
                if (this._bufferedBytes + data.input.byteLength >
                    MAX_BUFFERED_BYTES) {
                    throw new error_1.QvacErrorAddonWhisper({
                        code: error_1.ERR_CODES.BUFFER_LIMIT_EXCEEDED,
                        adds: `${MAX_BUFFERED_BYTES} bytes`,
                    });
                }
                this._bufferedAudio.push(data.input);
                this._bufferedBytes += data.input.byteLength;
                return this._nextJobId;
            }
            throw new Error(`Unknown append input type: ${data?.type}`);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_APPEND,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    async status() {
        try {
            return this._state;
        }
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_GET_STATUS,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    async destroyInstance() {
        if (this._handle === null)
            return;
        try {
            try {
                if (this._activeJobId !== null) {
                    await this._binding.cancel(this._handle);
                }
            }
            catch { }
            this._binding.destroyInstance(this._handle);
            this._handle = null;
            this._bufferedAudio = [];
            this._bufferedBytes = 0;
            this._activeJobId = null;
            this._setState(state.IDLE);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_DESTROY,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    async runJob(data) {
        const currentJobId = this._nextJobId;
        const previousJobId = this._activeJobId;
        const previousState = this._state;
        try {
            const accepted = this._binding.runJob(this._requiredHandle(), {
                ...data,
                audio_format: data?.audio_format || this._audioFormat,
            });
            if (!accepted) {
                this._activeJobId = previousJobId;
                this._setState(previousState);
                return false;
            }
            this._activeJobId = currentJobId;
            this._nextJobId = nextSafeId(this._nextJobId);
            this._setState(state.PROCESSING);
            return true;
        }
        catch (err) {
            this._activeJobId = previousJobId;
            this._setState(previousState);
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_APPEND,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    startStreaming(config = {}) {
        try {
            this._activeJobId = this._nextJobId;
            this._nextJobId = nextSafeId(this._nextJobId);
            this._setState(state.PROCESSING);
            this._binding.startStreaming(this._requiredHandle(), {
                ...config,
                jobId: this._activeJobId,
            });
        }
        catch (err) {
            this._activeJobId = null;
            this._setState(state.LISTENING);
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_START_STREAMING,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    appendStreamingAudio(data) {
        try {
            if (!(data.input instanceof Uint8Array)) {
                throw new Error("Audio input must be Uint8Array");
            }
            this._binding.appendStreamingAudio(this._requiredHandle(), {
                type: "audio",
                input: data.input,
                audio_format: data.audio_format || this._audioFormat,
            });
        }
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_APPEND_STREAMING,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    endStreaming() {
        try {
            this._binding.endStreaming(this._requiredHandle());
        }
        catch (err) {
            throw new error_1.QvacErrorAddonWhisper({
                code: error_1.ERR_CODES.FAILED_TO_END_STREAMING,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    finishStreaming() {
        this._activeJobId = null;
        this._setState(state.LISTENING);
    }
    _drainBufferedAudio() {
        const input = this._concatBufferedAudio();
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        return input;
    }
    _concatBufferedAudio() {
        if (this._bufferedAudio.length === 0)
            return new Uint8Array();
        if (this._bufferedAudio.length === 1) {
            return this._bufferedAudio[0];
        }
        const totalLength = this._bufferedAudio.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of this._bufferedAudio) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return merged;
    }
    _requiredHandle() {
        if (this._handle === null)
            throw new Error("Addon instance is destroyed");
        return this._handle;
    }
}
exports.WhisperInterface = WhisperInterface;
