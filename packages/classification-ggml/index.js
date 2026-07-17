"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageClassifier = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const env = require("bare-env");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
const DEFAULT_WEIGHTS_FILENAME = "mobilenetv3_3class_v3_fp16.gguf";
const RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";
function resolveDefaultModelPath() {
    if (env.QVAC_CLASSIFICATION_MODEL_PATH) {
        return env.QVAC_CLASSIFICATION_MODEL_PATH;
    }
    return path.join(__dirname, "weights", DEFAULT_WEIGHTS_FILENAME);
}
function getErrorMessage(error, fallback) {
    if (error && typeof error === "object" && "message" in error) {
        const message = error.message;
        if (typeof message === "string" && message)
            return message;
    }
    return typeof error === "string" ? error : fallback;
}
/**
 * High-level classifier for MobileNetV3-Small 3-class image triage.
 *
 * ```js
 * const classifier = new ImageClassifier()
 * await classifier.load()
 * const result = await classifier.classify(jpegBuffer)
 * // [ { label: 'food', confidence: 0.93 }, ... ]
 * await classifier.unload()
 * ```
 */
class ImageClassifier {
    logger;
    modelPath;
    nativeLogger;
    addon;
    job;
    runExclusive;
    hasActiveResponse;
    state;
    constructor(opts = {}) {
        const { modelPath, logger = undefined, nativeLogger = false } = opts;
        this.modelPath = modelPath ?? resolveDefaultModelPath();
        this.logger = new QvacLogger(logger);
        // Off by default: see `addon.js::_ensureLoggerInstalled` for the
        // process-wide JsLogger lifecycle that opt-in unlocks.
        this.nativeLogger = nativeLogger === true;
        this.addon = null;
        this.job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
        this.runExclusive = (0, infer_base_1.exclusiveRunQueue)();
        this.hasActiveResponse = false;
        this.state = { configLoaded: false, destroyed: false };
    }
    getState() {
        return { ...this.state };
    }
    /** Loads the model and native resources. Idempotent. */
    async load() {
        return this.runExclusive(async () => {
            if (this.state.configLoaded)
                return;
            await this.loadInternal();
            this.state.configLoaded = true;
            this.logger.info?.("ImageClassifier loaded");
        });
    }
    async loadInternal() {
        if (!fs.existsSync(this.modelPath)) {
            throw new Error(`MobileNet GGUF weights not found at: ${this.modelPath}`);
        }
        // configurationParams is the C++ schema 1:1. Keep it free of any
        // JS-only flags. The native-logger gate lives in the JS-side opts arg.
        const configurationParams = {
            path: this.modelPath,
            config: { backendsDir: path.join(__dirname, "prebuilds") },
        };
        const disableNativeLogger = !this.nativeLogger || env.QVAC_CLASSIFICATION_DISABLE_NATIVE_LOGGER === "1";
        try {
            this.addon = this.createAddon(configurationParams, { disableNativeLogger });
            await this.addon.activate();
        }
        catch (loadError) {
            this.logger.error?.("Error during model load:", loadError);
            try {
                await this.addon?.unload?.();
            }
            catch { }
            this.addon = null;
            throw loadError;
        }
    }
    createAddon(configurationParams, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("./binding");
        return new addon_1.ClassificationInterface(binding, configurationParams, this.addonOutputCallback.bind(this), this.logger, opts);
    }
    /**
     * Classifies one image.
     *
     * @param imageInput JPEG/PNG buffer, or raw RGB bytes with
     *                                `options.width`, `options.height`, `options.channels=3`.
     * @param options
     * @returns sorted by `confidence` descending. Always returns all classes
     *          unless `options.topK` is set.
     */
    async classify(imageInput, options = undefined) {
        return this.runExclusive(() => this.classifyInternal(imageInput, options));
    }
    async classifyInternal(imageInput, options) {
        if (!this.addon || !this.state.configLoaded) {
            throw new Error("Classifier not loaded. Call load() first.");
        }
        if (this.hasActiveResponse) {
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        const job = { type: "image", content: imageInput };
        if (options) {
            if (options.width !== undefined)
                job.width = options.width;
            if (options.height !== undefined)
                job.height = options.height;
            if (options.channels !== undefined)
                job.channels = options.channels;
            if (options.topK !== undefined)
                job.topK = options.topK;
        }
        const response = this.job.start();
        let accepted;
        try {
            accepted = await this.addon.runJob(job);
        }
        catch (err) {
            this.job.fail(err);
            throw err;
        }
        if (!accepted) {
            const err = new Error("Classification job was rejected by the native runner");
            this.job.fail(err);
            throw err;
        }
        this.hasActiveResponse = true;
        const collected = await response.await().finally(() => {
            this.hasActiveResponse = false;
        });
        // QvacResponse collects each Output event into an array; classify
        // emits exactly one, so unwrap to preserve the public shape.
        return Array.isArray(collected) && Array.isArray(collected[0])
            ? collected[0]
            : collected;
    }
    handleAddonOutputEvent(eventType, data, error) {
        if (eventType === "LogMsg") {
            const msg = typeof data === "string"
                ? data
                : getErrorMessage(data, JSON.stringify(data));
            this.logger.info?.(msg);
            return;
        }
        if (eventType === "Error") {
            const err = error instanceof Error
                ? error
                : new Error(getErrorMessage(error, "Classification failed"));
            this.job.fail(err);
        }
        else if (eventType === "Output") {
            this.job.output(data);
        }
        else if (eventType === "JobEnded") {
            this.job.end();
        }
    }
    addonOutputCallback(_addon, event, data, error) {
        const mapped = (0, addon_1.mapAddonEvent)(event, data, error);
        if (mapped === null)
            return;
        this.handleAddonOutputEvent(mapped.type, mapped.data, mapped.error);
    }
    /** Idempotent. Cancels any in-flight job before destroying the handle. */
    async unload() {
        return this.runExclusive(async () => {
            try {
                if (this.addon?.cancel)
                    await this.addon.cancel();
            }
            catch { }
            if (this.job.active) {
                this.job.fail(new Error("Model was unloaded"));
            }
            this.hasActiveResponse = false;
            if (this.addon) {
                await this.addon.unload();
                this.addon = null;
            }
            this.state.configLoaded = false;
        });
    }
    /** Releases native resources and marks this instance as destroyed. */
    async destroy() {
        await this.unload();
        this.state.destroyed = true;
    }
}
exports.ImageClassifier = ImageClassifier;
exports.default = ImageClassifier;
const cjsExports = ImageClassifier;
cjsExports.ImageClassifier = ImageClassifier;
module.exports = cjsExports;
