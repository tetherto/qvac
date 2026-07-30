"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslationInterface = void 0;
const error_1 = require("./lib/error");
const log_forward_1 = require("./lib/log-forward");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding");
/** Extract a human-readable message from an unknown thrown value. */
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
/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class TranslationInterface {
    _handle;
    _loggerInitialized;
    /**
     * @param configurationParams - all the required configuration for inference setup
     * @param outputCb - to be called on any inference event ( started, new output, error, etc )
     * @param transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
     */
    constructor(configurationParams, outputCb, transitionCb = null) {
        this._handle = binding.createInstance(this, configurationParams, outputCb);
        // Set up C++ → JS logger
        this._loggerInitialized = false;
        if (transitionCb && typeof transitionCb === "object") {
            binding.setLogger((priority, message) => {
                // Must invoke logger methods on the logger object — QvacLogger relies
                // on `this` internally, so the call must not be detached.
                (0, log_forward_1.forwardTransitionLog)(transitionCb, priority, message);
            });
            this._loggerInitialized = true;
        }
    }
    // For BaseInference.
    async destroyInstance() {
        await this.destroy();
    }
    /**
     * Stops addon process and clears resources (including memory).
     */
    async unload() {
        await this.destroy();
    }
    /**
     * Loads weights for the model.
     * Can only be invoked after instance is constructed or after load()/reload() are called
     * @param weightsData
     * @param weightsData.filename
     * @param weightsData.contents
     * @param weightsData.completed
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async to preserve rejected-promise (not sync-throw) semantics for callers.
    async loadWeights(weightsData) {
        try {
            binding.loadWeights(this._handle, weightsData);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonMarian({
                code: error_1.ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    /**
     * Moves addon to the LISTENING state after all the initialization is done
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async to preserve rejected-promise (not sync-throw) semantics for callers.
    async activate() {
        try {
            binding.activate(this._handle);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonMarian({
                code: error_1.ERR_CODES.FAILED_TO_ACTIVATE,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    /**
     * Cancel a inference process
     */
    async cancel() {
        try {
            await binding.cancel(this._handle);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonMarian({
                code: error_1.ERR_CODES.FAILED_TO_CANCEL,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    /**
     * Returns the name of the currently-loaded non-CPU backend (e.g. 'Vulkan0',
     * 'OpenCL', 'Metal'), or a sentinel string:
     *   - 'Unloaded'     — model is not loaded
     *   - 'Bergamot-CPU' — Bergamot model (CPU-only by design)
     *   - 'CPU'          — GGML backend loaded, only CPU backend registered
     *
     * Synchronous by design: reads cached state populated at load() time.
     * @returns {string}
     */
    getActiveBackendName() {
        if (this._handle === null) {
            return "Unloaded";
        }
        try {
            return binding.getActiveBackendName(this._handle);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonMarian({
                code: error_1.ERR_CODES.FAILED_TO_GET_BACKEND_NAME,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    /**
     * Returns the human-readable device description for the active GPU backend
     * (e.g. 'NVIDIA GeForce RTX 5070', 'Intel(R) UHD Graphics').
     * Returns '' when no GPU backend is loaded or model is unloaded.
     *
     * Silently catches native errors — the description is informational and
     * callers should not fail when the backend cannot provide one. This
     * intentionally diverges from the error-throwing pattern used by other
     * binding wrappers in this class.
     * @returns {string}
     */
    getActiveBackendDescription() {
        if (this._handle === null) {
            return "";
        }
        try {
            return binding.getActiveBackendDescription(this._handle);
        }
        catch {
            return "";
        }
    }
    /**
     * Submits a job to the processing pipeline
     * @param data
     * @param data.type - 'text' for single input, 'sequences' for batch
     * @param data.input
     * @returns {boolean} true if job was accepted
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async to preserve rejected-promise (not sync-throw) semantics for callers.
    async runJob(data) {
        try {
            return binding.runJob(this._handle, data);
        }
        catch (err) {
            throw new error_1.QvacErrorAddonMarian({
                code: error_1.ERR_CODES.FAILED_TO_APPEND,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
    /**
     * Stops addon process and clears resources (including memory).
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async to preserve rejected-promise (not sync-throw) semantics for callers.
    async destroy() {
        // If already destroyed, do nothing
        if (this._handle === null) {
            return;
        }
        try {
            // Clean up logger before destroying instance
            if (this._loggerInitialized) {
                binding.releaseLogger();
                this._loggerInitialized = false;
            }
            binding.destroyInstance(this._handle);
            this._handle = null;
        }
        catch (err) {
            throw new error_1.QvacErrorAddonMarian({
                code: error_1.ERR_CODES.FAILED_TO_DESTROY,
                adds: errorMessage(err),
                cause: err,
            });
        }
    }
}
exports.TranslationInterface = TranslationInterface;
