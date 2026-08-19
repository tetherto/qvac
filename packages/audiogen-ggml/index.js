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
exports.RepaintMode = exports.AudioEditOperationType = exports.QvacErrorAudioGen = exports.ERR_CODES = exports.ERR_CODE_RANGE = exports.OUTPUT_FORMATS = exports.pcmToWav = exports.encodePcm = exports.allRegistryPaths = exports.resolveDitModelPath = exports.modelSources = exports.modelManifest = exports.modelFilenames = exports.registryPath = exports.ditFilename = exports.ditVariants = exports.DEFAULT_DIT_VARIANT = exports.DIT_VARIANTS = exports.FIXED_MODELS = exports.REGISTRY_PREFIX = exports.REGISTRY_SOURCE = exports.AudioGen = exports.AudioEditSession = exports.ENGINE_ACESTEP = void 0;
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
const AUDIO_LATENT_RATE = 25;
const LATENT_FRAME_SECONDS = 1 / AUDIO_LATENT_RATE;
const REPAINT_RANGE_EPSILON_SECONDS = 1e-5;
const FLOW_EDIT_TURBO_VARIANTS = 'turbo-q4, turbo-q8';
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
function requireNormalizedPcm(value, name) {
    for (const sample of value) {
        if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
            throw invalidInput(`${name} must contain finite samples in [-1, 1]`);
        }
    }
}
function int16ToNormalizedFloat32(pcm) {
    const converted = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; ++i) {
        const sample = pcm[i];
        converted[i] = sample < 0 ? sample / 32768 : sample / 32767;
    }
    return converted;
}
function isSftDit(ditVariant, ditModelPath) {
    if (ditVariant === 'sft')
        return true;
    if (ditModelPath === undefined)
        return false;
    const file = ditModelPath.split(/[/\\]/).pop() ?? '';
    return /(?:^|[^a-z])sft(?:[^a-z]|$)/i.test(file.replace(/\.gguf$/i, ''));
}
function sourceDurationSeconds(source) {
    return source.pcm.length / source.channels / source.sampleRate;
}
function requireRepaintRange(source, start, end) {
    const duration = sourceDurationSeconds(source);
    const resolvedEnd = end === -1 ? duration : end;
    if (start > duration + REPAINT_RANGE_EPSILON_SECONDS) {
        throw invalidInput('repaint.start must be within the source duration');
    }
    if (end !== -1 && end > duration + REPAINT_RANGE_EPSILON_SECONDS) {
        throw invalidInput('repaint.end must be within the source duration');
    }
    if (resolvedEnd - start < LATENT_FRAME_SECONDS - REPAINT_RANGE_EPSILON_SECONDS) {
        throw invalidInput('repaint range must span at least one latent frame');
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
function requireEditSource(source) {
    if (typeof source !== 'object' || source === null) {
        throw invalidInput('edit source must be an audio source object');
    }
    if (source.sampleRate !== 48000) {
        throw invalidInput(`edit source sampleRate must be 48000, got ${source.sampleRate}`);
    }
    if (source.channels !== 2) {
        throw invalidInput(`edit source channels must be 2, got ${source.channels}`);
    }
    if (!(source.pcm instanceof Float32Array) && !(source.pcm instanceof Int16Array)) {
        throw invalidInput('edit source pcm must be a Float32Array or Int16Array');
    }
    if (source.pcm.length === 0) {
        throw invalidInput('edit source pcm must not be empty');
    }
    if ((source.pcm.length & 1) !== 0) {
        throw invalidInput('edit source pcm must be interleaved stereo');
    }
    if (source.pcm instanceof Float32Array) {
        requireNormalizedPcm(source.pcm, 'edit source pcm');
        return source.pcm;
    }
    return int16ToNormalizedFloat32(source.pcm);
}
function requirePrompt(prompt, name) {
    if (typeof prompt !== 'object' || prompt === null) {
        throw invalidInput(`${name} must be an object`);
    }
    if (typeof prompt.caption !== 'string' || prompt.caption.trim().length === 0) {
        throw invalidInput(`${name}.caption must be a non-empty string`);
    }
    if (prompt.lyrics !== undefined && typeof prompt.lyrics !== 'string') {
        throw invalidInput(`${name}.lyrics must be a string`);
    }
    return prompt;
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
 * Fluent, ordered edit pipeline. Every call appends one operation; operations
 * may be repeated in any order before the session is submitted with `run()`.
 */
class AudioEditSession {
    _source;
    _runner;
    _allowFlowEdit;
    _operations = [];
    _started = false;
    constructor(_source, _runner, _allowFlowEdit) {
        this._source = _source;
        this._runner = _runner;
        this._allowFlowEdit = _allowFlowEdit;
    }
    /** Append a Flow-Edit operation. v1 supports turbo DiT only. */
    flowEdit(options) {
        if (this._started)
            throw invalidInput('cannot modify an edit session after run()');
        if (!this._allowFlowEdit) {
            throw invalidInput(`flowEdit is supported on turbo DiT variants only (${FLOW_EDIT_TURBO_VARIANTS})`);
        }
        if (typeof options !== 'object' || options === null) {
            throw invalidInput('flowEdit options must be an object');
        }
        const from = requirePrompt(options.from, 'flowEdit.from');
        const to = requirePrompt(options.to, 'flowEdit.to');
        const nMin = requireFiniteNumber(options.nMin ?? 0, 'flowEdit.nMin');
        const nMax = requireFiniteNumber(options.nMax ?? 1, 'flowEdit.nMax');
        const nAvg = requireFiniteNumber(options.nAvg ?? 1, 'flowEdit.nAvg', true);
        if (nMin < 0 || nMax > 1 || nMin > nMax) {
            throw invalidInput('flowEdit requires 0 <= nMin <= nMax <= 1');
        }
        if (nAvg < 1)
            throw invalidInput('flowEdit.nAvg must be at least 1');
        this._operations.push({
            type: audiogen_1.AudioEditOperationType.FlowEdit,
            sourceCaption: from.caption,
            sourceLyrics: from.lyrics ?? '[Instrumental]',
            targetCaption: to.caption,
            targetLyrics: to.lyrics ?? '[Instrumental]',
            nMin,
            nMax,
            nAvg
        });
        return this;
    }
    /** Alias for `flowEdit()` so `.edit().repaint().edit()` reads naturally. */
    edit(options) {
        return this.flowEdit(options);
    }
    /** Append a timeline Repaint operation. */
    repaint(options) {
        if (this._started)
            throw invalidInput('cannot modify an edit session after run()');
        const prompt = requirePrompt(options, 'repaint');
        const start = requireFiniteNumber(options.start, 'repaint.start');
        const end = optionalFiniteNumber(options.end, 'repaint.end') ?? -1;
        const mode = options.mode ?? audiogen_1.RepaintMode.Balanced;
        const strength = requireFiniteNumber(options.strength ?? 0.5, 'repaint.strength');
        if (start < 0)
            throw invalidInput('repaint.start must be non-negative');
        if (end !== -1 && end <= start) {
            throw invalidInput('repaint.end must be greater than repaint.start');
        }
        requireRepaintRange(this._source, start, end);
        if (!Object.values(audiogen_1.RepaintMode).includes(mode)) {
            throw invalidInput('repaint.mode must be conservative|balanced|aggressive');
        }
        if (strength < 0 || strength > 1) {
            throw invalidInput('repaint.strength must be between 0 and 1');
        }
        this._operations.push({
            type: audiogen_1.AudioEditOperationType.Repaint,
            caption: prompt.caption,
            lyrics: prompt.lyrics ?? '[Instrumental]',
            start,
            end,
            mode,
            strength
        });
        return this;
    }
    async run(options = {}) {
        if (this._started)
            throw invalidInput('edit session run() may only be called once');
        if (this._operations.length === 0) {
            throw invalidInput('edit session requires at least one edit or repaint operation');
        }
        if (typeof options !== 'object' || options === null) {
            throw invalidInput('edit session run options must be an object');
        }
        const seed = optionalFiniteNumber(options.seed, 'edit.seed', true);
        this._started = true;
        return this._runner(this._source, this._operations, { seed });
    }
}
exports.AudioEditSession = AudioEditSession;
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
    _ditVariant;
    _lifecycleRevision;
    _destroyed;
    _cancelPromise;
    _cancellingResponse;
    constructor(options = {}) {
        this._logger = new QvacLogger(options.logger);
        const files = options.files ?? {};
        const config = options.config ?? {};
        this._ditVariant = files.ditVariant;
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
    /**
     * Start a source-driven edit pipeline. Flow-Edit and Repaint operations may
     * be repeated and are executed in the exact order in which they are chained.
     * Flow-Edit is turbo DiT only (`turbo-q4`, `turbo-q8`).
     */
    edit(source) {
        return new AudioEditSession(source, async (audio, operations, options) => this._runEdit(audio, operations, options), !isSftDit(this._ditVariant, this._configuration.ditModelPath));
    }
    async _runEdit(source, operations, options) {
        const sourceAudio = requireEditSource(source);
        const jobData = {
            type: 'edit',
            input: '',
            sourceAudio,
            editOperations: [...operations],
            seed: options.seed
        };
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
var audiogen_2 = require("./audiogen");
Object.defineProperty(exports, "AudioEditOperationType", { enumerable: true, get: function () { return audiogen_2.AudioEditOperationType; } });
Object.defineProperty(exports, "RepaintMode", { enumerable: true, get: function () { return audiogen_2.RepaintMode; } });
