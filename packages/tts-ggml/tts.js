"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTSInterface = void 0;
const error_1 = require("./lib/error");
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (error && typeof error === "object" && "message" in error) {
        const message = error.message;
        if (typeof message === "string")
            return message;
    }
    return String(error);
}
function errorCause(error) {
    return error instanceof Error ? error : new Error(errorMessage(error));
}
/** An interface between the Bare addon in C++ and the JS runtime. */
class TTSInterface {
    _binding;
    _handle;
    constructor(binding, configuration = {}, outputCallback = null) {
        this._binding = binding;
        this._handle = this._binding.createInstance(this, configuration, outputCallback);
    }
    async activate() {
        try {
            await this._binding.activate(this._handle);
        }
        catch (error) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_ACTIVATE,
                adds: errorMessage(error),
                cause: errorCause(error),
            });
        }
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- preserves the established promise-returning wrapper API.
    async runJob(data) {
        try {
            this._binding.runJob(this._handle, data);
        }
        catch (error) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_APPEND,
                adds: errorMessage(error),
                cause: errorCause(error),
            });
        }
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- preserves the established promise-returning wrapper API.
    async loadWeights(weightsData) {
        try {
            this._binding.loadWeights(this._handle, weightsData);
        }
        catch (error) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_LOAD,
                adds: errorMessage(error),
                cause: errorCause(error),
            });
        }
    }
    async cancel() {
        try {
            await this._binding.cancel(this._handle);
        }
        catch (error) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_CANCEL,
                adds: errorMessage(error),
                cause: errorCause(error),
            });
        }
    }
    async destroyInstance() {
        if (this._handle === null)
            return;
        try {
            const handle = this._handle;
            this._handle = null;
            await this._binding.destroyInstance(handle);
        }
        catch (error) {
            throw new error_1.QvacErrorAddonTTSGgml({
                code: error_1.ERR_CODES.FAILED_TO_DESTROY,
                adds: errorMessage(error),
                cause: errorCause(error),
            });
        }
    }
    async unload() {
        return this.destroyInstance();
    }
}
exports.TTSInterface = TTSInterface;
