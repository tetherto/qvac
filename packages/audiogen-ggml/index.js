"use strict";
// @qvac/audiogen-ggml
//
// Audio generation (music) addon for qvac, ggml backend. Text prompt in ->
// stereo audio out, powered by the ACE-Step engine in audiogen-cpp
// (text-encoder + LM + DiT + VAE), compiled natively per-platform and linked
// via vcpkg — same shape as @qvac/tts-ggml.
//
// The high-level `AudioGen` class implements the shared qvac addon contract:
// `load()` once, then `run()` returns a `@qvac/infer-base` `QvacResponse` that
// streams the engine's output (progress ticks + one interleaved-Int16 PCM
// chunk) and resolves with the run stats.
Object.defineProperty(exports, "__esModule", { value: true });
exports.QvacErrorAudioGen = exports.ERR_CODES = exports.ERR_CODE_RANGE = exports.OUTPUT_FORMATS = exports.pcmToWav = exports.encodePcm = exports.allRegistryPaths = exports.resolveDitModelPath = exports.modelSources = exports.modelManifest = exports.modelFilenames = exports.registryPath = exports.ditFilename = exports.ditVariants = exports.DEFAULT_DIT_VARIANT = exports.DIT_VARIANTS = exports.FIXED_MODELS = exports.REGISTRY_PREFIX = exports.REGISTRY_SOURCE = exports.AudioGen = exports.ENGINE_ACESTEP = void 0;
const infer_base_1 = require("@qvac/infer-base");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- @qvac/logging exposes a CommonJS export-assignment shape.
const QvacLogger = require("@qvac/logging");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-path is a CommonJS module.
const path = require("bare-path");
const audiogen_1 = require("./audiogen");
const models_1 = require("./models");
const audio_format_1 = require("./lib/audio-format");
const error_1 = require("./error");
exports.ENGINE_ACESTEP = 'acestep';
function asNativeData(data) {
    if (typeof data !== 'object' || data === null)
        return null;
    // `object` is assignable to NativeAudiogenData (every field is optional); the
    // per-field `typeof` guards below do the real runtime narrowing.
    return data;
}
// The native config parser `static_cast<int>`s these numbers, and casting
// NaN/Infinity to an integer is undefined behavior. Reject non-finite (and
// non-integer, where required) values on the JS side with a clear error before
// they ever reach C++.
function requireFiniteNumber(value, name, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidInput(`${name} must be a finite number, got ${value}`);
    }
    if (integer && !Number.isInteger(value)) {
        throw invalidInput(`${name} must be an integer, got ${value}`);
    }
    return value;
}
function optionalFiniteNumber(value, name, integer = false) {
    return value === undefined ? undefined : requireFiniteNumber(value, name, integer);
}
const GENERATE_TASK_TYPES = new Set(['text2music', 'cover', 'cover-nofsq']);
function optionalTaskType(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !GENERATE_TASK_TYPES.has(value)) {
        throw invalidInput('taskType must be one of text2music|cover|cover-nofsq');
    }
    return value;
}
function requireFinitePcm(value, name) {
    for (const sample of value) {
        if (!Number.isFinite(sample)) {
            throw invalidInput(`${name} must contain only finite samples`);
        }
    }
}
function optionalStereoPcm(value, name) {
    if (value === undefined)
        return undefined;
    if (!(value instanceof Float32Array)) {
        throw invalidInput(`${name} must be a Float32Array`);
    }
    if ((value.length & 1) !== 0) {
        throw invalidInput(`${name} must be interleaved stereo`);
    }
    requireFinitePcm(value, name);
    return value;
}
function isCoverTask(taskType) {
    return taskType === 'cover' || taskType === 'cover-nofsq';
}
function invalidInput(message) {
    return new error_1.QvacErrorAudioGen({ code: error_1.ERR_CODES.INVALID_INPUT, adds: message });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * GGML-backed music generation via the ACE-Step engine. Owns a persistent
 * native engine: the four model stages are loaded once by `load()` and reused
 * by every `run()`.
 */
class AudioGen {
    static inferenceManagerConfig = {
        noAdditionalDownload: true
    };
    static ENGINE_ACESTEP = exports.ENGINE_ACESTEP;
    addon;
    _job;
    _runExclusive;
    _configuration;
    _logger;
    _lifecycleRevision;
    _destroyed;
    _cancelPromise;
    _cancellingResponse;
    constructor(options = {}) {
        this._logger = new QvacLogger(options.logger);
        const files = options.files ?? {};
        const config = options.config ?? {};
        // DiT selection: an explicit `ditModel` path always wins; otherwise a
        // `ditVariant` enum picks which DiT GGUF to load from `modelDir` (the three
        // other stages are fixed, so the variant is the only real choice).
        const ditModelPath = (0, models_1.resolveDitModelPath)({
            modelDir: files.modelDir,
            ditModel: files.ditModel,
            ditVariant: files.ditVariant
        });
        // The native side carries NO defaults: it requires every numeric/bool field
        // and throws if one is missing. JS is the single place that decides defaults.
        // 0 for inferenceSteps/shift/threads means "auto"; nGpuLayers 99 = all layers
        // (only applied by the engine when useGPU is true).
        const useGpu = config.useGPU ?? false;
        this._configuration = {
            engineType: exports.ENGINE_ACESTEP,
            modelDir: files.modelDir,
            textEncModelPath: files.textEncModel,
            lmModelPath: files.lmModel,
            ditModelPath,
            vaeModelPath: files.vaeModel,
            inferenceSteps: requireFiniteNumber(config.inferenceSteps ?? 0, 'inferenceSteps', true),
            shift: requireFiniteNumber(config.shift ?? 0, 'shift'),
            useGPU: useGpu,
            nGpuLayers: requireFiniteNumber(config.nGpuLayers ?? 99, 'nGpuLayers', true),
            threads: requireFiniteNumber(config.threads ?? 0, 'threads', true),
            // Where the native engine dlopens the ggml backend modules staged next to
            // the `.bare`. Default to the package's own prebuilds dir; the C++ side
            // appends the per-target BACKENDS_SUBDIR. Required on arm64 (per-microarch
            // MODULE CPU backends); harmless on static desktop / Apple builds.
            backendsDir: config.backendsDir ?? path.join(__dirname, 'prebuilds')
        };
        this.addon = null;
        this._job = (0, infer_base_1.createJobHandler)({
            cancel: () => this.addon?.cancel() ?? Promise.resolve()
        });
        this._runExclusive = (0, infer_base_1.exclusiveRunQueue)();
        this._lifecycleRevision = 0;
        this._destroyed = false;
        this._cancelPromise = null;
        this._cancellingResponse = null;
    }
    /** Create the native engine and load every stage GGUF. Idempotent. */
    async load() {
        const revision = this._lifecycleRevision;
        return this._runExclusive(() => this._load(revision));
    }
    async _load(revision) {
        if (revision !== this._lifecycleRevision || this._destroyed) {
            throw this._lifecycleError();
        }
        if (this.addon)
            return;
        this._logger.info('audiogen-ggml: loading ACE-Step engine');
        const addon = this._createAddon(this._configuration, this._addonOutputCallback.bind(this));
        this.addon = addon;
        // If activation fails, tear down the half-initialized native handle and
        // clear `this.addon` so a later load() can retry instead of no-op'ing on a
        // dead instance. Mirrors the cleanup pattern in tts-ggml._load().
        try {
            await addon.activate();
            if (revision !== this._lifecycleRevision || this._destroyed) {
                throw this._lifecycleError();
            }
        }
        catch (error) {
            if (this.addon === addon) {
                this.addon = null;
                try {
                    await addon.destroyInstance();
                }
                catch { }
            }
            if (error instanceof error_1.QvacErrorAudioGen)
                throw error;
            throw new error_1.QvacErrorAudioGen({
                code: error_1.ERR_CODES.FAILED_TO_LOAD,
                adds: errorMessage(error),
                cause: error instanceof Error ? error : undefined
            });
        }
        this._logger.info('audiogen-ggml: engine ready');
    }
    /**
     * Generate music from a text prompt. Returns a `QvacResponse` that streams
     * progress ticks + the PCM chunk and resolves (`await()`) with the run stats.
     */
    async run(caption, opts = {}) {
        const jobData = this._createJobData(caption, opts);
        const revision = this._lifecycleRevision;
        return new Promise((resolve, reject) => {
            const queued = this._runExclusive(() => this._admitAndWait(jobData, revision, resolve, reject));
            void queued.catch(reject);
        });
    }
    async _admitAndWait(jobData, revision, resolve, reject) {
        if (revision !== this._lifecycleRevision) {
            throw this._lifecycleError();
        }
        const addon = this._requireAddon();
        const response = this._job.start();
        let accepted;
        try {
            accepted = await addon.runJob(jobData);
        }
        catch (error) {
            const runError = new error_1.QvacErrorAudioGen({
                code: error_1.ERR_CODES.FAILED_TO_START_JOB,
                adds: errorMessage(error),
                cause: error instanceof Error ? error : undefined
            });
            response.failed(runError);
            reject(runError);
            return;
        }
        if (accepted !== true) {
            const admissionError = new error_1.QvacErrorAudioGen({ code: error_1.ERR_CODES.JOB_ALREADY_RUNNING });
            response.failed(admissionError);
            reject(admissionError);
            return;
        }
        resolve(response);
        try {
            await response.await();
        }
        catch { }
    }
    _createJobData(caption, opts) {
        if (typeof caption !== 'string' || caption.trim().length === 0) {
            throw invalidInput('caption must be a non-empty string');
        }
        this._logger.debug(`audiogen-ggml: run (caption ${caption.length} chars, lyrics=${opts.lyrics ? 'yes' : 'no'})`);
        if (opts.lmPhase1 !== undefined && typeof opts.lmPhase1 !== 'boolean') {
            throw invalidInput('lmPhase1 must be a boolean');
        }
        if (opts.dcwEnabled !== undefined && typeof opts.dcwEnabled !== 'boolean') {
            throw invalidInput('dcwEnabled must be a boolean');
        }
        if (opts.audioCodes !== undefined && !(opts.audioCodes instanceof Int32Array)) {
            throw invalidInput('audioCodes must be an Int32Array');
        }
        const taskType = optionalTaskType(opts.taskType);
        const referenceAudio = optionalStereoPcm(opts.referenceAudio, 'referenceAudio');
        const sourceAudio = optionalStereoPcm(opts.sourceAudio, 'sourceAudio');
        if (isCoverTask(taskType) && (sourceAudio === undefined || sourceAudio.length === 0)) {
            throw invalidInput(`taskType '${taskType}' requires sourceAudio`);
        }
        return {
            type: 'text',
            input: caption,
            lyrics: opts.lyrics ?? '[Instrumental]',
            seed: optionalFiniteNumber(opts.seed, 'seed', true),
            vocalLanguage: opts.vocalLanguage,
            bpm: optionalFiniteNumber(opts.bpm, 'bpm', true),
            keyscale: opts.keyscale,
            timesignature: opts.timesignature,
            duration: optionalFiniteNumber(opts.duration, 'duration'),
            lmTemperature: optionalFiniteNumber(opts.lmTemperature, 'lmTemperature'),
            lmTopP: optionalFiniteNumber(opts.lmTopP, 'lmTopP'),
            lmTopK: optionalFiniteNumber(opts.lmTopK, 'lmTopK', true),
            lmCfgScale: optionalFiniteNumber(opts.lmCfgScale, 'lmCfgScale'),
            lmPhase1: opts.lmPhase1,
            dcwEnabled: opts.dcwEnabled,
            dcwScaler: optionalFiniteNumber(opts.dcwScaler, 'dcwScaler'),
            dcwHighScaler: optionalFiniteNumber(opts.dcwHighScaler, 'dcwHighScaler'),
            audioCodes: opts.audioCodes,
            referenceAudio,
            sourceAudio,
            taskType,
            audioCoverStrength: optionalFiniteNumber(opts.audioCoverStrength, 'audioCoverStrength'),
            coverNoiseStrength: optionalFiniteNumber(opts.coverNoiseStrength, 'coverNoiseStrength')
        };
    }
    async cancel() {
        const response = this._job.active;
        if (!response)
            return;
        if (this._cancelPromise)
            return this._cancelPromise;
        const cancellation = this._cancelActiveResponse(response);
        this._cancelPromise = cancellation;
        const cancellationError = new error_1.QvacErrorAudioGen({ code: error_1.ERR_CODES.CANCELLED });
        try {
            await cancellation;
            response.failed(cancellationError);
        }
        finally {
            if (this._cancelPromise === cancellation)
                this._cancelPromise = null;
            if (this._cancellingResponse === response)
                this._cancellingResponse = null;
        }
    }
    async _cancelActiveResponse(response) {
        this._cancellingResponse = response;
        try {
            await (this.addon?.cancel() ?? Promise.resolve());
        }
        catch (error) {
            const failedError = this._failedCancelError(error);
            response.failed(failedError);
            throw failedError;
        }
    }
    async unload() {
        await this._stop(new error_1.QvacErrorAudioGen({ code: error_1.ERR_CODES.MODEL_UNLOADED }));
    }
    async destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        await this._stop(new error_1.QvacErrorAudioGen({ code: error_1.ERR_CODES.INSTANCE_DESTROYED }));
    }
    async _stop(settlementError) {
        this._lifecycleRevision++;
        const addon = this.addon;
        this.addon = null;
        let cancellation = Promise.resolve();
        let cancellationFailure = null;
        if (addon && this._job.active) {
            try {
                cancellation = addon.cancel();
            }
            catch (error) {
                cancellationFailure = this._failedCancelError(error);
            }
        }
        this._job.active?.failed(settlementError);
        await this._runExclusive(async () => {
            try {
                await cancellation;
            }
            catch (error) {
                cancellationFailure = this._failedCancelError(error);
            }
            if (!addon) {
                if (cancellationFailure)
                    throw cancellationFailure;
                return;
            }
            let destructionFailure = null;
            try {
                await addon.destroyInstance();
            }
            catch (error) {
                destructionFailure = new error_1.QvacErrorAudioGen({
                    code: error_1.ERR_CODES.FAILED_TO_DESTROY,
                    adds: errorMessage(error),
                    cause: error instanceof Error ? error : undefined
                });
            }
            if (cancellationFailure)
                throw cancellationFailure;
            if (destructionFailure)
                throw destructionFailure;
            this._logger.debug('audiogen-ggml: engine unloaded');
        });
    }
    static encode(pcm, formats, opts) {
        return (0, audio_format_1.encodePcm)(pcm, formats, opts);
    }
    static getModelKey(_params) {
        void _params;
        return 'audiogen-ggml';
    }
    _createAddon(configuration, outputCallback) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
        const binding = require('./binding');
        return new audiogen_1.AudioGenInterface(binding, configuration, outputCallback);
    }
    _addonOutputCallback(_handle, _event, data, error) {
        if (this._cancellingResponse)
            return;
        if (typeof error === 'string' && error.length > 0) {
            this._logger.error(`audiogen-ggml: engine error: ${error}`);
            this._job.fail(new error_1.QvacErrorAudioGen({
                code: error_1.ERR_CODES.INFERENCE_FAILED,
                adds: error
            }));
            return;
        }
        const d = asNativeData(data);
        if (!d)
            return;
        if (typeof d.progressTotal === 'number') {
            this._job.output({
                progress: {
                    stage: d.progressStage ?? '',
                    step: d.progressStep ?? 0,
                    total: d.progressTotal
                }
            });
            return;
        }
        if (d.outputArray) {
            this._job.output({
                outputArray: d.outputArray,
                sampleRate: d.sampleRate ?? 0,
                channels: d.channels ?? 0
            });
            return;
        }
        if (typeof d.audioDurationMs === 'number' || typeof d.totalTimeMs === 'number') {
            const stats = {
                ...(typeof d.audioDurationMs === 'number' ? { audioDurationMs: d.audioDurationMs } : {}),
                ...(typeof d.totalTimeMs === 'number' ? { totalTimeMs: d.totalTimeMs } : {}),
                ...(typeof d.realTimeFactor === 'number' ? { realTimeFactor: d.realTimeFactor } : {}),
                ...(typeof d.backendDevice === 'number' ? { backendDevice: d.backendDevice } : {}),
                ...(typeof d.backendId === 'number' ? { backendId: d.backendId } : {})
            };
            this._job.end(stats, stats);
        }
    }
    _requireAddon() {
        if (!this.addon)
            throw this._lifecycleError();
        return this.addon;
    }
    _lifecycleError() {
        return new error_1.QvacErrorAudioGen({
            code: this._destroyed ? error_1.ERR_CODES.INSTANCE_DESTROYED : error_1.ERR_CODES.NOT_LOADED
        });
    }
    _failedCancelError(error) {
        return new error_1.QvacErrorAudioGen({
            code: error_1.ERR_CODES.FAILED_TO_CANCEL,
            adds: errorMessage(error),
            cause: error instanceof Error ? error : undefined
        });
    }
}
exports.AudioGen = AudioGen;
var models_2 = require("./models");
Object.defineProperty(exports, "REGISTRY_SOURCE", { enumerable: true, get: function () { return models_2.REGISTRY_SOURCE; } });
Object.defineProperty(exports, "REGISTRY_PREFIX", { enumerable: true, get: function () { return models_2.REGISTRY_PREFIX; } });
Object.defineProperty(exports, "FIXED_MODELS", { enumerable: true, get: function () { return models_2.FIXED_MODELS; } });
Object.defineProperty(exports, "DIT_VARIANTS", { enumerable: true, get: function () { return models_2.DIT_VARIANTS; } });
Object.defineProperty(exports, "DEFAULT_DIT_VARIANT", { enumerable: true, get: function () { return models_2.DEFAULT_DIT_VARIANT; } });
Object.defineProperty(exports, "ditVariants", { enumerable: true, get: function () { return models_2.ditVariants; } });
Object.defineProperty(exports, "ditFilename", { enumerable: true, get: function () { return models_2.ditFilename; } });
Object.defineProperty(exports, "registryPath", { enumerable: true, get: function () { return models_2.registryPath; } });
Object.defineProperty(exports, "modelFilenames", { enumerable: true, get: function () { return models_2.modelFilenames; } });
Object.defineProperty(exports, "modelManifest", { enumerable: true, get: function () { return models_2.modelManifest; } });
Object.defineProperty(exports, "modelSources", { enumerable: true, get: function () { return models_2.modelSources; } });
Object.defineProperty(exports, "resolveDitModelPath", { enumerable: true, get: function () { return models_2.resolveDitModelPath; } });
Object.defineProperty(exports, "allRegistryPaths", { enumerable: true, get: function () { return models_2.allRegistryPaths; } });
var audio_format_2 = require("./lib/audio-format");
Object.defineProperty(exports, "encodePcm", { enumerable: true, get: function () { return audio_format_2.encodePcm; } });
Object.defineProperty(exports, "pcmToWav", { enumerable: true, get: function () { return audio_format_2.pcmToWav; } });
Object.defineProperty(exports, "OUTPUT_FORMATS", { enumerable: true, get: function () { return audio_format_2.SUPPORTED_FORMATS; } });
var error_2 = require("./error");
Object.defineProperty(exports, "ERR_CODE_RANGE", { enumerable: true, get: function () { return error_2.ERR_CODE_RANGE; } });
Object.defineProperty(exports, "ERR_CODES", { enumerable: true, get: function () { return error_2.ERR_CODES; } });
Object.defineProperty(exports, "QvacErrorAudioGen", { enumerable: true, get: function () { return error_2.QvacErrorAudioGen; } });
