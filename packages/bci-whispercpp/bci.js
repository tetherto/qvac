"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BCIInterface = exports.MAX_BUFFERED_BYTES = exports.END_OF_INPUT = void 0;
exports.nextSafeId = nextSafeId;
exports.concatChunks = concatChunks;
const error_1 = require("./lib/error");
const constants_1 = require("./lib/constants");
const configChecker_1 = require("./configChecker");
const state = Object.freeze({
    LOADING: "loading",
    LISTENING: "listening",
    PROCESSING: "processing",
    IDLE: "idle",
});
exports.END_OF_INPUT = "end of job";
// Upper bound on buffered neural-signal bytes between append() calls.
// Neural data is ~1 MB/s at 512ch * 50 Hz * 4 B, so 500 MB ~= 8 minutes of
// signal. The bound matches transcription-whispercpp and protects against
// runaway producers.
exports.MAX_BUFFERED_BYTES = 500 * 1024 * 1024;
function nextSafeId(current) {
    return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}
/** Concatenate a list of byte chunks into a single contiguous Uint8Array. */
function concatChunks(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}
/**
 * Low-level interface between the Bare C++ BCI addon and the JS runtime.
 * Accepts neural signal data (Uint8Array) instead of audio.
 */
class BCIInterface {
    static END_OF_INPUT = exports.END_OF_INPUT;
    _binding;
    _outputCb;
    _transitionCb;
    _nextJobId;
    _activeJobId;
    _bufferedSignal;
    _bufferedBytes;
    _state;
    _handle;
    constructor(binding, configurationParams, outputCb, transitionCb = null) {
        this._binding = binding;
        this._outputCb = outputCb;
        this._transitionCb = transitionCb;
        this._nextJobId = 1;
        this._activeJobId = null;
        this._bufferedSignal = [];
        this._bufferedBytes = 0;
        this._state = state.LOADING;
        (0, configChecker_1.checkConfig)(configurationParams);
        this._handle = this._binding.createInstance(this, configurationParams, this._addonOutputCallback.bind(this), transitionCb);
    }
    _setState(newState) {
        this._state = newState;
        if (this._transitionCb) {
            this._transitionCb(this, newState);
        }
    }
    _addonOutputCallback(addon, event, data, error) {
        const eventName = typeof event === "string" ? event : "";
        const isError = typeof error === "string" && error.length > 0;
        const isStats = data !== null &&
            typeof data === "object" &&
            ("totalTime" in data || "tokensPerSecond" in data || "totalWallMs" in data);
        const isTranscriptOutput = (Array.isArray(data) && data.length > 0) ||
            (data !== null &&
                typeof data === "object" &&
                typeof data.text === "string");
        let mappedEvent = eventName;
        if (eventName === constants_1.ADDON_EVENT.ERROR || isError || eventName.includes("Error")) {
            mappedEvent = constants_1.ADDON_EVENT.ERROR;
        }
        else if (eventName === constants_1.ADDON_EVENT.JOB_ENDED ||
            isStats ||
            eventName.includes("RuntimeStats")) {
            mappedEvent = constants_1.ADDON_EVENT.JOB_ENDED;
        }
        else if (eventName === constants_1.ADDON_EVENT.OUTPUT || isTranscriptOutput) {
            mappedEvent = constants_1.ADDON_EVENT.OUTPUT;
        }
        else if (Array.isArray(data) && data.length === 0) {
            return;
        }
        const jobId = this._activeJobId;
        if (jobId === null) {
            return;
        }
        if (mappedEvent === constants_1.ADDON_EVENT.OUTPUT) {
            this._setState(state.PROCESSING);
            if (Array.isArray(data)) {
                const segments = data;
                if (segments.length > 0 && typeof segments[0]?.text === "string") {
                    for (const segment of segments) {
                        this._outputCb(addon, constants_1.ADDON_EVENT.OUTPUT, jobId, [segment], null);
                    }
                }
                else {
                    this._outputCb(addon, constants_1.ADDON_EVENT.OUTPUT, jobId, data, null);
                }
            }
            else if (data !== null &&
                typeof data === "object" &&
                typeof data.text === "string") {
                this._outputCb(addon, constants_1.ADDON_EVENT.OUTPUT, jobId, [data], null);
            }
            else {
                this._outputCb(addon, constants_1.ADDON_EVENT.OUTPUT, jobId, data, null);
            }
            return;
        }
        this._outputCb(addon, mappedEvent, jobId, data, isError ? error : null);
        if (mappedEvent === constants_1.ADDON_EVENT.ERROR || mappedEvent === constants_1.ADDON_EVENT.JOB_ENDED) {
            this._activeJobId = null;
            this._setState(state.LISTENING);
        }
    }
    async unload() {
        await this.destroyInstance();
    }
    async load(configurationParams) {
        (0, configChecker_1.checkConfig)(configurationParams);
        await this.destroyInstance();
        this._handle = this._binding.createInstance(this, configurationParams, this._addonOutputCallback.bind(this), this._transitionCb);
        this._setState(state.LOADING);
    }
    async reload(configurationParams) {
        (0, configChecker_1.checkConfig)(configurationParams);
        await this.cancel();
        if (typeof this._binding.reload === "function") {
            await this._binding.reload(this._handle, configurationParams);
            this._setState(state.LOADING);
            return;
        }
        await this.load(configurationParams);
    }
    loadWeights(weightsData) {
        try {
            this._binding.loadWeights(this._handle, weightsData);
        }
        catch (err) {
            return Promise.reject(new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            }));
        }
        return Promise.resolve();
    }
    unloadWeights() {
        return Promise.resolve(true);
    }
    activate() {
        try {
            this._binding.activate(this._handle);
            this._setState(state.LISTENING);
        }
        catch (err) {
            return Promise.reject(new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.FAILED_TO_ACTIVATE,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            }));
        }
        return Promise.resolve();
    }
    async cancel(jobId) {
        try {
            await this._binding.cancel(this._handle, jobId);
            this._bufferedSignal = [];
            this._bufferedBytes = 0;
            this._activeJobId = null;
            this._setState(state.LISTENING);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.FAILED_TO_CANCEL,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            });
        }
    }
    /**
     * Appends neural signal data to the processing buffer.
     * Send { type: 'end of job' } to trigger processing.
     * @returns job ID
     */
    append(data) {
        try {
            return Promise.resolve(this._appendSync(data));
        }
        catch (err) {
            if (err instanceof error_1.QvacErrorAddonBCI)
                return Promise.reject(err);
            return Promise.reject(new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.FAILED_TO_APPEND,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            }));
        }
    }
    _appendSync(data) {
        if (data.type === exports.END_OF_INPUT) {
            if (this._bufferedSignal.length === 0) {
                throw new error_1.QvacErrorAddonBCI({
                    code: error_1.ERR_CODES.INVALID_NEURAL_INPUT,
                    adds: "no neural signal data was appended before end-of-job",
                });
            }
            const currentJobId = this._nextJobId;
            const input = this._concatBufferedSignal();
            const previousState = this._state;
            const previousJobId = this._activeJobId;
            let accepted = false;
            try {
                accepted = this._binding.runJob(this._handle, {
                    type: "neural",
                    input,
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
                throw new error_1.QvacErrorAddonBCI({ code: error_1.ERR_CODES.JOB_ALREADY_RUNNING });
            }
            this._activeJobId = currentJobId;
            this._nextJobId = nextSafeId(this._nextJobId);
            this._bufferedSignal = [];
            this._bufferedBytes = 0;
            this._setState(state.PROCESSING);
            return currentJobId;
        }
        if (data.type === "neural") {
            if (!(data.input instanceof Uint8Array)) {
                throw new error_1.QvacErrorAddonBCI({
                    code: error_1.ERR_CODES.INVALID_NEURAL_INPUT,
                    adds: "input must be Uint8Array",
                });
            }
            if (this._bufferedBytes + data.input.byteLength > exports.MAX_BUFFERED_BYTES) {
                throw new error_1.QvacErrorAddonBCI({
                    code: error_1.ERR_CODES.BUFFER_LIMIT_EXCEEDED,
                    adds: exports.MAX_BUFFERED_BYTES + " bytes",
                });
            }
            this._bufferedSignal.push(data.input);
            this._bufferedBytes += data.input.byteLength;
            return this._nextJobId;
        }
        throw new Error(`Unknown append input type: ${data.type}`);
    }
    /**
     * Run a single batch job directly with neural signal data.
     */
    runJob(data) {
        if (!data || !(data.input instanceof Uint8Array)) {
            return Promise.reject(new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.INVALID_NEURAL_INPUT,
                adds: "runJob input must be a Uint8Array",
            }));
        }
        if (data.input.byteLength === 0) {
            return Promise.reject(new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.INVALID_NEURAL_INPUT,
                adds: "runJob input must not be empty",
            }));
        }
        const candidateJobId = this._nextJobId;
        const previousState = this._state;
        const previousJobId = this._activeJobId;
        let accepted = false;
        try {
            accepted = this._binding.runJob(this._handle, {
                type: "neural",
                input: data.input,
            });
        }
        catch (err) {
            this._activeJobId = previousJobId;
            this._setState(previousState);
            return Promise.reject(new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.FAILED_TO_START_JOB,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            }));
        }
        if (!accepted) {
            this._activeJobId = previousJobId;
            this._setState(previousState);
            return Promise.resolve(false);
        }
        this._activeJobId = candidateJobId;
        this._nextJobId = nextSafeId(this._nextJobId);
        this._setState(state.PROCESSING);
        return Promise.resolve(accepted);
    }
    status() {
        return Promise.resolve(this._state);
    }
    async destroyInstance() {
        if (this._handle === null) {
            return;
        }
        try {
            try {
                await this._binding.cancel(this._handle);
            }
            catch { }
            this._binding.destroyInstance(this._handle);
            this._handle = null;
            this._bufferedSignal = [];
            this._bufferedBytes = 0;
            this._activeJobId = null;
            this._setState(state.IDLE);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonBCI({
                code: error_1.ERR_CODES.FAILED_TO_DESTROY,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            });
        }
    }
    _concatBufferedSignal() {
        if (this._bufferedSignal.length === 0) {
            return new Uint8Array();
        }
        if (this._bufferedSignal.length === 1) {
            return this._bufferedSignal[0];
        }
        return concatChunks(this._bufferedSignal);
    }
}
exports.BCIInterface = BCIInterface;
