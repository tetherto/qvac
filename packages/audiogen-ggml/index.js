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
exports.OUTPUT_FORMATS = exports.pcmToWav = exports.encodePcm = exports.allRegistryPaths = exports.resolveDitModelPath = exports.modelSources = exports.modelManifest = exports.modelFilenames = exports.registryPath = exports.ditFilename = exports.ditVariants = exports.DEFAULT_DIT_VARIANT = exports.DIT_VARIANTS = exports.FIXED_MODELS = exports.REGISTRY_PREFIX = exports.REGISTRY_SOURCE = exports.AudioGen = exports.ENGINE_ACESTEP = void 0;
const infer_base_1 = require("@qvac/infer-base");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- @qvac/logging exposes a CommonJS export-assignment shape.
const QvacLogger = require("@qvac/logging");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-path is a CommonJS module.
const path = require("bare-path");
const audiogen_1 = require("./audiogen");
const models_1 = require("./models");
const audio_format_1 = require("./lib/audio-format");
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
        throw new Error(`audiogen-ggml: ${name} must be a finite number, got ${value}`);
    }
    if (integer && !Number.isInteger(value)) {
        throw new Error(`audiogen-ggml: ${name} must be an integer, got ${value}`);
    }
    return value;
}
function optionalFiniteNumber(value, name, integer = false) {
    return value === undefined ? undefined : requireFiniteNumber(value, name, integer);
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
    _configuration;
    _logger;
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
    }
    /** Create the native engine and load every stage GGUF. Idempotent. */
    async load() {
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
        }
        catch (error) {
            try {
                await addon.destroyInstance();
            }
            catch {
                // best-effort teardown; surface the original activation error below.
            }
            if (this.addon === addon)
                this.addon = null;
            throw error;
        }
        this._logger.info('audiogen-ggml: engine ready');
    }
    /**
     * Generate music from a text prompt. Returns a `QvacResponse` that streams
     * progress ticks + the PCM chunk and resolves (`await()`) with the run stats.
     */
    async run(caption, opts = {}) {
        // start() is typed QvacResponse<any>; run()'s explicit return type narrows
        // the public surface to QvacResponse<AudiogenOutputChunk>.
        this._logger.debug(`audiogen-ggml: run (caption ${caption.length} chars, lyrics=${opts.lyrics ? 'yes' : 'no'})`);
        const response = this._job.start();
        try {
            await this._requireAddon().runJob({
                type: 'text',
                input: caption,
                lyrics: opts.lyrics ?? '[Instrumental]',
                seed: optionalFiniteNumber(opts.seed, 'seed', true),
                vocalLanguage: opts.vocalLanguage,
                bpm: optionalFiniteNumber(opts.bpm, 'bpm', true),
                keyscale: opts.keyscale,
                timesignature: opts.timesignature,
                duration: optionalFiniteNumber(opts.duration, 'duration')
            });
        }
        catch (error) {
            this._logger.error(`audiogen-ggml: run failed: ${error instanceof Error ? error.message : String(error)}`);
            this._job.fail(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        return response;
    }
    async cancel() {
        await this.addon?.cancel();
    }
    async unload() {
        const addon = this.addon;
        this.addon = null;
        if (addon) {
            await addon.destroyInstance();
            this._logger.debug('audiogen-ggml: engine unloaded');
        }
    }
    async destroy() {
        await this.unload();
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
        if (typeof error === 'string' && error.length > 0) {
            this._logger.error(`audiogen-ggml: engine error: ${error}`);
            this._job.fail(new Error(error));
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
            throw new Error('AudioGen addon is not loaded (call load() first)');
        return this.addon;
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
