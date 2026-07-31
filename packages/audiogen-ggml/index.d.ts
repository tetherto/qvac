import { type QvacResponse } from '@qvac/infer-base';
import QvacLogger = require('@qvac/logging');
import { AudioGenInterface } from './audiogen';
import { type DitVariant } from './models';
import { type EncodeOptions, type EncodedAudio, type OutputFormat } from './lib/audio-format';
export declare const ENGINE_ACESTEP = "acestep";
/** Model file paths for the four ACE-Step stages. */
export interface AudioGenFiles {
    /** Directory holding the four ACE-Step GGUFs (engine auto-classifies them). */
    modelDir?: string;
    /** Explicit text-encoder GGUF path. */
    textEncModel?: string;
    /** Explicit LM GGUF path. */
    lmModel?: string;
    /** Explicit DiT GGUF path (wins over `ditVariant`). */
    ditModel?: string;
    /** Selects the DiT GGUF from `modelDir` when `ditModel` is not given. */
    ditVariant?: DitVariant;
    /** Explicit VAE GGUF path. */
    vaeModel?: string;
}
/** Runtime knobs handed to the native engine. */
export interface AudioGenRuntimeConfig {
    /** 0 = engine auto-picks per DiT architecture (turbo 8 / sft 50). */
    inferenceSteps?: number;
    /** 0 = engine auto-picks per DiT architecture (turbo 3.0 / sft 1.0). */
    shift?: number;
    useGPU?: boolean;
    /** GPU layers to offload when `useGPU` is set (99 = all). Ignored when off. */
    nGpuLayers?: number;
    /** 0 = engine auto-picks. */
    threads?: number;
    /**
     * Override the prebuilds root the native engine scans for dlopen'd ggml
     * backend modules. Defaults to `<addon>/prebuilds` (correct for the shipped
     * package); only set this for a non-standard prebuilds layout. Needed on
     * arm64, where the CPU backend is a set of per-microarch MODULE .so files.
     */
    backendsDir?: string;
}
export interface AudioGenOptions {
    /** Model file paths for the four stages. */
    files?: AudioGenFiles;
    /** Runtime knobs (steps, shift, GPU, threads). */
    config?: AudioGenRuntimeConfig;
    /** Underlying logger; wrapped by a level-gated QvacLogger (defaults to off). */
    logger?: QvacLogger.LoggerInterface;
}
export interface GenerateOptions {
    lyrics?: string;
    seed?: number;
    vocalLanguage?: string;
    /** Beats per minute; 0/undefined lets the LM infer it. */
    bpm?: number;
    /** Key + scale, e.g. "C minor". */
    keyscale?: string;
    /** Time signature, e.g. "4/4". */
    timesignature?: string;
    /** Target length in seconds; undefined lets the LM decide the full length. */
    duration?: number;
}
/** A per-step progress tick from the engine (stage = "lm" | "dit" | "vae"). */
export interface AudiogenProgress {
    stage: string;
    step: number;
    total: number;
}
/** One interleaved-Int16 PCM chunk emitted by the engine. */
export interface AudiogenPcmChunk {
    outputArray: Int16Array;
    sampleRate: number;
    channels: number;
}
/** A progress tick delivered through the run's output stream. */
export interface AudiogenProgressChunk {
    progress: AudiogenProgress;
}
/** Items streamed by the `QvacResponse` returned from `run()`. */
export type AudiogenOutputChunk = AudiogenPcmChunk | AudiogenProgressChunk;
/**
 * Terminal run stats, resolved by `QvacResponse.await()`. These mirror exactly
 * what the native `AcestepModel::runtimeStats()` emits — `totalTimeMs`,
 * `realTimeFactor`, `audioDurationMs` and the resolved backend. Sample rate and
 * channel count are NOT here: they ride on each PCM chunk instead (see
 * `AudiogenPcmChunk`).
 *
 * `backendDevice` / `backendId` describe the backend the engine actually ran
 * on, not the one requested, so a `useGPU: true` run that fell back to the CPU
 * is detectable. Codes match @qvac/tts-ggml.
 */
export interface AudiogenStats {
    audioDurationMs?: number;
    totalTimeMs?: number;
    realTimeFactor?: number;
    /** 0 = CPU, 1 = GPU. */
    backendDevice?: number;
    /** 0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL, 99 = other. */
    backendId?: number;
}
/**
 * GGML-backed music generation via the ACE-Step engine. Owns a persistent
 * native engine: the four model stages are loaded once by `load()` and reused
 * by every `run()`.
 */
export declare class AudioGen {
    static readonly inferenceManagerConfig: {
        noAdditionalDownload: boolean;
    };
    static readonly ENGINE_ACESTEP = "acestep";
    addon: AudioGenInterface | null;
    private readonly _job;
    private readonly _configuration;
    private readonly _logger;
    constructor(options?: AudioGenOptions);
    /** Create the native engine and load every stage GGUF. Idempotent. */
    load(): Promise<void>;
    /**
     * Generate music from a text prompt. Returns a `QvacResponse` that streams
     * progress ticks + the PCM chunk and resolves (`await()`) with the run stats.
     */
    run(caption: string, opts?: GenerateOptions): Promise<QvacResponse<AudiogenOutputChunk>>;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    destroy(): Promise<void>;
    /**
     * Encode interleaved Int16 PCM into one or more output formats. Pass a single
     * format for one file, or an array to produce several at once (input order).
     * See {@link OUTPUT_FORMATS} for the allowed values.
     */
    static encode(pcm: Uint8Array, format?: OutputFormat, opts?: EncodeOptions): EncodedAudio;
    static encode(pcm: Uint8Array, formats: OutputFormat[], opts?: EncodeOptions): EncodedAudio[];
    static getModelKey(_params?: unknown): string;
    private _createAddon;
    private _addonOutputCallback;
    private _requireAddon;
}
export { REGISTRY_SOURCE, REGISTRY_PREFIX, FIXED_MODELS, DIT_VARIANTS, DEFAULT_DIT_VARIANT, ditVariants, ditFilename, registryPath, modelFilenames, modelManifest, modelSources, resolveDitModelPath, allRegistryPaths } from './models';
export type { DitVariant, ModelManifest, ModelSources, ResolveDitModelPathOptions } from './models';
export { encodePcm, pcmToWav, SUPPORTED_FORMATS as OUTPUT_FORMATS } from './lib/audio-format';
export type { OutputFormat, EncodeOptions, EncodedAudio } from './lib/audio-format';
export type { AudioGenConfigurationParams, AudioGenJobData, AudioGenBinding, AudioGenOutputCallback } from './audiogen';
