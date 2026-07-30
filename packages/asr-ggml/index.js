"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const error_1 = require("./lib/error");
const types_1 = require("./lib/types");
const driver_1 = require("./engines/whisper/driver");
const driver_2 = require("./engines/parakeet/driver");
const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46]; // ASCII "GGUF"
/**
 * Creates one serialized queue lane. `"onReturn"` releases the slot when
 * `fn()` settles; `"onSettle"` requires `fn()` to resolve with a
 * `QvacResponse` and holds the slot until that response settles.
 *
 * There are deliberately TWO lanes per instance (see `ASRGgml`): inference
 * and lifecycle. They must stay independent — a single shared lane would
 * make `unload()`/`destroy()`/`reload()` queue behind an in-flight `run()`,
 * which both pre-merge packages allowed to be pre-empted, and would deadlock
 * teardown forever on a `run()` whose input iterable never terminates.
 */
function createQueueLane() {
    let tail = Promise.resolve();
    return {
        async run(fn, policy) {
            const prev = tail;
            let releaseSlot = () => { };
            tail = new Promise((resolve) => {
                releaseSlot = resolve;
            });
            await prev;
            if (policy === "onReturn") {
                try {
                    return await fn();
                }
                finally {
                    releaseSlot();
                }
            }
            let result;
            try {
                result = await fn();
            }
            catch (err) {
                releaseSlot();
                throw err;
            }
            void result
                .await()
                .finally(() => {
                releaseSlot();
            })
                .catch(() => { });
            return result;
        },
    };
}
/**
 * Best-effort engine sniffing from the model file's magic bytes: GGUF →
 * parakeet, anything else → whisper (legacy GGML `.bin`). Docs and the SDK
 * plugins always pass `engine` explicitly; this is a convenience fallback.
 */
function sniffEngine(modelPath) {
    let fd = null;
    try {
        fd = fs.openSync(modelPath, "r");
        const magic = new Uint8Array(4);
        const bytesRead = fs.readSync(fd, magic, 0, 4, 0);
        const isGguf = bytesRead === 4 &&
            GGUF_MAGIC.every((byte, index) => magic[index] === byte);
        return isGguf ? "parakeet" : "whisper";
    }
    catch (err) {
        throw new error_1.QvacErrorAddonASRGgml({
            code: error_1.ERR_CODES.INVALID_ENGINE,
            adds: "pass engine or config.engine explicitly",
            cause: err instanceof Error ? err : undefined,
        });
    }
    finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
}
function isKnownEngine(value) {
    return value === "whisper" || value === "parakeet";
}
/**
 * The model file the driver will actually open. Whisper's
 * `contextParams`-adjacent `config.path` overrides `files.model` (a
 * long-standing whisper escape hatch), so constructor validation and engine
 * sniffing must target the same expression the driver loads —
 * `WhisperDriver._buildConfigurationParams()`. Parakeet only ever loads
 * `files.model`.
 *
 * `engine === null` means the engine still has to be sniffed, which can only
 * happen when no `config` was supplied at all — and therefore no `path`.
 */
function resolveModelPath(files, config, engine) {
    if (engine === "whisper") {
        const configuredPath = config?.path;
        if (typeof configuredPath === "string" && configuredPath.length > 0) {
            return configuredPath;
        }
    }
    return files.model;
}
/**
 * Unified multi-engine ASR client for the whisper and parakeet GGML
 * engines. The engine is selected per instance (`config.engine`, `engine`,
 * or model-file sniffing); the public method surface is engine-agnostic
 * while config vocabularies stay engine-scoped.
 */
class ASRGgml {
    static ENGINE_WHISPER = "whisper";
    static ENGINE_PARAKEET = "parakeet";
    static ERR_CODES = error_1.ERR_CODES;
    static Error = error_1.QvacErrorAddonASRGgml;
    static inferenceManagerConfig = Object.freeze({
        noAdditionalDownload: true,
    });
    static getModelKey() {
        return "asr-ggml";
    }
    logger;
    exclusiveRun;
    enableStats;
    state;
    _engineType;
    _driver;
    _job;
    /** Serializes `run()` / `runStreaming()` against each other. */
    _inferenceQueue;
    /**
     * Serializes `reload()` / `unload()` / `destroy()` against each other,
     * independently of `_inferenceQueue`, so teardown can pre-empt an in-flight
     * run (as both pre-merge packages did) and can never deadlock behind one.
     */
    _lifecycleQueue;
    _openSession;
    constructor(options) {
        const { files, config, engine, enableStats = true, logger = null, exclusiveRun = true, } = options || {};
        // 1. Model path is required.
        if (!files || typeof files.model !== "string" || files.model.length === 0) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.MODEL_REQUIRED,
                adds: "files.model is required",
            });
        }
        this.logger = new QvacLogger(logger ?? undefined);
        this.exclusiveRun = !!exclusiveRun;
        this.enableStats = enableStats !== false;
        this.state = {
            configLoaded: false,
            weightsLoaded: false,
            destroyed: false,
        };
        this._inferenceQueue = createQueueLane();
        this._lifecycleQueue = createQueueLane();
        this._openSession = null;
        // 2. Resolve the declared engine (config.engine ?? engine). `null` means
        //    nothing was declared and the engine has to be sniffed — which needs
        //    a readable model file, so it happens after step 3.
        const declaredEngine = this._resolveDeclaredEngine(config, engine);
        // 3. Strict file validation, on the path the driver will actually open
        //    (whisper honours `config.path` over `files.model`). This runs before
        //    sniffing so a missing model reports MODEL_NOT_FOUND rather than
        //    INVALID_ENGINE from the failed magic-byte read.
        const modelPath = resolveModelPath(files, config, declaredEngine);
        if (!fs.existsSync(modelPath)) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.MODEL_NOT_FOUND,
                adds: modelPath,
            });
        }
        this._engineType = declaredEngine ?? sniffEngine(modelPath);
        if (this._engineType === "whisper") {
            this._validateWhisperVadModel(files, config);
        }
        // 4. Construct the driver.
        this._job = (0, infer_base_1.createJobHandler)({
            cancel: () => this._driver.cancelActive(),
        });
        const ctx = {
            logger: this.logger,
            job: this._job,
            enableStats: this.enableStats,
        };
        if (this._engineType === "parakeet") {
            this._driver = new driver_2.ParakeetDriver(ctx, files, config || { engine: "parakeet" });
        }
        else {
            this._driver = new driver_1.WhisperDriver(ctx, files, config || { engine: "whisper" });
        }
        this.logger.debug("ASRGgml constructor called", {
            engine: this._engineType,
            modelPath,
            config,
        });
        // 5. Constructor-time config validation.
        this._driver.validateConfig();
    }
    getState() {
        return this.state;
    }
    getEngineType() {
        return this._engineType;
    }
    getBackendInfo() {
        return this._driver.getBackendInfo();
    }
    /**
     * The native interface owned by the engine driver, or `undefined` before
     * `load()`. As in both pre-merge packages it is NOT cleared by `unload()` —
     * the interface object outlives its native instance and reports `IDLE`.
     *
     * This is the escape hatch the SDK's model-wide hard cancel uses
     * (`packages/sdk/server/bare/ops/transcribe.ts` reads `model.addon` and
     * calls `addon.cancel()`): unlike `ASRGgml.cancel()`, it stops the native
     * decode WITHOUT failing the active job, so the op's `for await` loop can
     * end normally instead of throwing. Both pre-merge packages exposed `addon`
     * on the instance; keep it exposed. Not otherwise part of the supported
     * surface — drive the engine through `ASRGgml`.
     */
    get addon() {
        return this._driver.addon;
    }
    async load() {
        if (this.state.destroyed) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.INSTANCE_DESTROYED,
            });
        }
        if (this.state.configLoaded || this.state.weightsLoaded) {
            this.logger.info("Reload requested - unloading existing model first");
            await this.unload();
        }
        await this._driver.load();
        this.state.configLoaded = true;
        this.state.weightsLoaded = true;
    }
    async unload() {
        return await this._lifecycleQueue.run(async () => {
            if (this._job.active) {
                this._job.fail(new Error("Model was unloaded"));
            }
            await this._driver.cancelActive();
            await this._driver.unload();
            this.state.configLoaded = false;
            this.state.weightsLoaded = false;
        }, "onReturn");
    }
    async destroy() {
        return await this._lifecycleQueue.run(async () => {
            if (this._job.active) {
                this._job.fail(new Error("Model was destroyed"));
            }
            await this._driver.cancelActive();
            await this._driver.unload();
            this.state.configLoaded = false;
            this.state.weightsLoaded = false;
            this.state.destroyed = true;
        }, "onReturn");
    }
    async reload(newConfig = {}) {
        if (!this._driver.supportsReload) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.NOT_SUPPORTED,
                adds: `reload on the ${this._engineType} engine`,
            });
        }
        return await this._lifecycleQueue.run(() => this._driver.reload(newConfig), "onReturn");
    }
    async cancel(jobId) {
        await this._driver.cancelActive(jobId);
    }
    async status() {
        return await this._driver.status();
    }
    pause() {
        return Promise.reject(new error_1.QvacErrorAddonASRGgml({
            code: error_1.ERR_CODES.NOT_SUPPORTED,
            adds: "pause",
        }));
    }
    unpause() {
        return Promise.reject(new error_1.QvacErrorAddonASRGgml({
            code: error_1.ERR_CODES.NOT_SUPPORTED,
            adds: "unpause",
        }));
    }
    async run(audio) {
        this._assertNoOpenSession("concurrent run() during an open streaming session");
        const runFn = () => this._driver.run(this._driver.normalizeAudio(audio));
        if (this.exclusiveRun) {
            return await this._inferenceQueue.run(runFn, "onSettle");
        }
        return await runFn();
    }
    async runStreaming(audio, opts = {}) {
        this._assertNoOpenSession("concurrent runStreaming() during an open streaming session");
        const startFn = async () => {
            const session = await this._driver.createStreamingSession(this._driver.normalizeAudio(audio), opts);
            this._openSession = session;
            void session.done.then(() => {
                if (this._openSession === session)
                    this._openSession = null;
            });
            return session.response;
        };
        if (this.exclusiveRun) {
            // The slot is held for session setup only, never for the
            // (potentially minutes-long) session itself.
            return await this._inferenceQueue.run(startFn, "onReturn");
        }
        return await startFn();
    }
    /**
     * Resolves the engine declared by the caller, or `null` when neither
     * `config.engine` nor `engine` was given and the engine must be sniffed
     * from the model file.
     */
    _resolveDeclaredEngine(config, engine) {
        if (config) {
            const configEngine = config.engine;
            if (configEngine === undefined) {
                throw new error_1.QvacErrorAddonASRGgml({
                    code: error_1.ERR_CODES.INVALID_ENGINE,
                    adds: "config.engine is required when config is provided",
                });
            }
            if (!isKnownEngine(configEngine)) {
                throw new error_1.QvacErrorAddonASRGgml({
                    code: error_1.ERR_CODES.INVALID_ENGINE,
                    adds: 'config.engine must be "whisper" or "parakeet"',
                });
            }
            return configEngine;
        }
        if (engine !== undefined) {
            if (!isKnownEngine(engine)) {
                throw new error_1.QvacErrorAddonASRGgml({
                    code: error_1.ERR_CODES.INVALID_ENGINE,
                    adds: `${String(engine)} — pass engine or config.engine explicitly`,
                });
            }
            return engine;
        }
        return null;
    }
    _validateWhisperVadModel(files, config) {
        const vadModelPath = config?.vadModelPath ||
            files.vadModel ||
            (typeof config?.whisperConfig?.vad_model_path === "string"
                ? config.whisperConfig.vad_model_path
                : null);
        if (vadModelPath && !fs.existsSync(vadModelPath)) {
            this.logger.error("VAD model file not found", { path: vadModelPath });
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.VAD_MODEL_NOT_FOUND,
                adds: vadModelPath,
            });
        }
    }
    _assertNoOpenSession(adds) {
        if (this._openSession) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES.STREAMING_SESSION_ACTIVE,
                adds,
            });
        }
    }
}
// The namespace merge preserves the package's established `export =` API and
// namespace-qualified public types such as `ASRGgml.RuntimeStats`.
// eslint-disable-next-line @typescript-eslint/no-namespace
(function (ASRGgml) {
    ASRGgml.BackendId = types_1.BackendId;
})(ASRGgml || (ASRGgml = {}));
module.exports = ASRGgml;
