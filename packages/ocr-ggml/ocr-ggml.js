"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OcrGgmlInterface = void 0;
const error_1 = require("./lib/error");
/**
 * Thin wrapper around the C++ bare addon. Mirrors the surface of
 * `translation-nmtcpp`'s `marian.js` / `ocr-onnx`'s `ocr-fasttext.js`.
 */
class OcrGgmlInterface {
    _binding;
    _handle;
    _loggerInitialized;
    /**
     * @param configurationParams - configuration for inference setup
     * @param outputCb - invoked on inference events (output, error, stats)
     * @param transitionCb - optional logger object with `info`/`warn`/`error`/`debug`
     *   methods. When provided, C++ log lines are forwarded via `binding.setLogger`.
     */
    constructor(binding, configurationParams, outputCb, transitionCb = null) {
        this._binding = binding;
        this._handle = this._binding.createInstance(this, configurationParams, outputCb);
        this._loggerInitialized = false;
        if (transitionCb && typeof transitionCb === "object") {
            this._binding.setLogger((priority, message) => {
                const levels = ["error", "warn", "info", "debug"];
                const level = levels[priority] || "info";
                // Invoke as a method on the logger object — QvacLogger methods rely
                // on `this` internally, so the call must not be detached.
                if (typeof transitionCb[level] === "function") {
                    transitionCb[level](message);
                }
            });
            this._loggerInitialized = true;
        }
    }
    async destroyInstance() {
        await this.destroy();
    }
    async unload() {
        await this.destroy();
    }
    /**
     * Moves the addon to LISTENING after construction-time work is finished.
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async so synchronous throws surface as promise rejections (preserves the original wrapper behavior).
    async activate() {
        try {
            this._binding.activate(this._handle);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonOcrGgml({
                code: error_1.ERR_CODES.FAILED_TO_ACTIVATE,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            });
        }
    }
    async cancel() {
        try {
            await this._binding.cancel(this._handle);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonOcrGgml({
                code: error_1.ERR_CODES.FAILED_TO_CANCEL,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            });
        }
    }
    /**
     * Submit an OCR inference job.
     * @param data.type - `'image'`
     * @param data.input - either `{ data, isEncoded: true }` for a raw JPEG/PNG
     *   buffer, or `{ data, width, height }` for raw RGB pixels.
     * @param data.options - optional per-run overrides.
     */
    async runJob(data) {
        try {
            // Return the native promise directly (no await): mirrors the original
            // wrapper, where only synchronous throws from invoking runJob are
            // wrapped and async rejections propagate unchanged.
            return this._binding.runJob(this._handle, data);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonOcrGgml({
                code: error_1.ERR_CODES.FAILED_TO_RUN_JOB,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            });
        }
    }
    /**
     * Returns the backend device the C++ pipeline resolved for inference.
     */
    getBackendInfo() {
        if (this._handle === null) {
            return null;
        }
        return this._binding.getBackendInfo(this._handle);
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async so synchronous throws surface as promise rejections (preserves the original wrapper behavior).
    async destroy() {
        if (this._handle === null) {
            return;
        }
        try {
            if (this._loggerInitialized) {
                this._binding.releaseLogger();
                this._loggerInitialized = false;
            }
            this._binding.destroyInstance(this._handle);
            this._handle = null;
        }
        catch (err) {
            throw new error_1.QvacErrorAddonOcrGgml({
                code: error_1.ERR_CODES.FAILED_TO_DESTROY,
                adds: (0, error_1.errorMessage)(err),
                cause: err,
            });
        }
    }
}
exports.OcrGgmlInterface = OcrGgmlInterface;
