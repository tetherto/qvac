import { type QvacResponse } from '@qvac/infer-base';
import QvacLogger = require('@qvac/logging');
import { AudioEditOperationType, AudioGenInterface, RepaintMode } from './audiogen';
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
    /** LM sampling temperature (ACE-Step default: 0.85). */
    lmTemperature?: number;
    /** LM nucleus-sampling probability (ACE-Step default: 0.9). */
    lmTopP?: number;
    /** LM top-k cutoff; 0 disables top-k filtering. */
    lmTopK?: number;
    /** Classifier-free guidance scale used by the LM. */
    lmCfgScale?: number;
    /** Allow the LM to infer missing metadata before semantic-code generation. */
    lmPhase1?: boolean;
    /** Apply official ACE-Step Haar DCW correction during DiT sampling (default: true). */
    dcwEnabled?: boolean;
    /** DCW low-frequency correction strength (official default: 0.05). */
    dcwScaler?: number;
    /** DCW high-frequency correction strength (official default: 0.02). */
    dcwHighScaler?: number;
    /** Frozen ACE-Step semantic codes; when present, skips the LM stage. */
    audioCodes?: Int32Array;
    /**
     * Optional timbre reference: interleaved stereo float PCM at 48 kHz.
     * Empty / omitted keeps the engine's canonical silence reference.
     */
    referenceAudio?: Float32Array;
    /**
     * Source / cover audio (same layout as `referenceAudio`). Required when
     * `taskType` is `"cover"` or `"cover-nofsq"`.
     */
    sourceAudio?: Float32Array;
    /**
     * Task discriminator. Supported today: `"text2music"` (default) |
     * `"cover-nofsq"`. `"cover"` (FSQ roundtrip) is accepted but not implemented
     * in the engine yet.
     */
    taskType?: 'text2music' | 'cover' | 'cover-nofsq';
    /**
     * Fraction of DiT steps that keep the source context (0..1). Default 1.0.
     * Values < 1 are rejected by the engine until context switching lands.
     */
    audioCoverStrength?: number;
    /**
     * Blend initial DiT noise toward clean source latents (0..1). 0 = pure noise;
     * 1 ≈ source latent. Default 0.
     */
    coverNoiseStrength?: number;
}
/** PCM accepted by the source-driven editing API. */
export interface AudioEditSource {
    /**
     * Interleaved stereo PCM. Float32 samples must be finite and in `[-1, 1]`.
     * Int16 output chunks can be reused directly.
     */
    pcm: Float32Array | Int16Array;
    sampleRate: number;
    channels: number;
}
export interface AudioEditPrompt {
    caption: string;
    lyrics?: string;
}
/** v1 Flow-Edit. Supported on turbo DiT only (`turbo-q4`, `turbo-q8`). */
export interface FlowEditOptions {
    /** Description of the unedited source audio. */
    from: AudioEditPrompt;
    /** Description of the desired audio. */
    to: AudioEditPrompt;
    /** Start of the flow-edit diffusion window, in [0, 1]. */
    nMin?: number;
    /** End of the flow-edit diffusion window, in [0, 1]. */
    nMax?: number;
    /** Number of forward-noise samples averaged per active step. */
    nAvg?: number;
}
export interface RepaintOptions extends AudioEditPrompt {
    /**
     * Repaint region start in seconds. Must lie inside the source duration and
     * leave at least one latent frame (`1/25` s) before `end`.
     */
    start: number;
    /**
     * Repaint region end in seconds. Omit to repaint through the source end.
     * Must not exceed the source duration.
     */
    end?: number;
    mode?: RepaintMode;
    /** Balanced-mode preservation strength in [0, 1]. */
    strength?: number;
}
export interface AudioEditRunOptions {
    /** Seeds the first operation; each following operation uses seed + its index. */
    seed?: number;
}
interface NativeFlowEditOperation {
    type: AudioEditOperationType.FlowEdit;
    sourceCaption: string;
    sourceLyrics: string;
    targetCaption: string;
    targetLyrics: string;
    nMin: number;
    nMax: number;
    nAvg: number;
}
interface NativeRepaintOperation {
    type: AudioEditOperationType.Repaint;
    caption: string;
    lyrics: string;
    start: number;
    end: number;
    mode: RepaintMode;
    strength: number;
}
export type AudioEditOperationData = NativeFlowEditOperation | NativeRepaintOperation;
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
type EditRunner = (source: AudioEditSource, operations: readonly AudioEditOperationData[], options: AudioEditRunOptions) => Promise<QvacResponse<AudiogenOutputChunk>>;
/**
 * Fluent, ordered edit pipeline. Every call appends one operation; operations
 * may be repeated in any order before the session is submitted with `run()`.
 */
export declare class AudioEditSession {
    private readonly _source;
    private readonly _runner;
    private readonly _allowFlowEdit;
    private readonly _operations;
    private _started;
    constructor(_source: AudioEditSource, _runner: EditRunner, _allowFlowEdit: boolean);
    /** Append a Flow-Edit operation. v1 supports turbo DiT only. */
    flowEdit(options: FlowEditOptions): this;
    /** Alias for `flowEdit()` so `.edit().repaint().edit()` reads naturally. */
    edit(options: FlowEditOptions): this;
    /** Append a timeline Repaint operation. */
    repaint(options: RepaintOptions): this;
    run(options?: AudioEditRunOptions): Promise<QvacResponse<AudiogenOutputChunk>>;
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
    private readonly _runExclusive;
    private readonly _configuration;
    private readonly _logger;
    private readonly _ditVariant;
    private _lifecycleRevision;
    private _destroyed;
    private _cancelPromise;
    private _cancellingResponse;
    constructor(options?: AudioGenOptions);
    /** Create the native engine and load every stage GGUF. Idempotent. */
    load(): Promise<void>;
    private _load;
    /**
     * Generate music from a text prompt. Returns a `QvacResponse` that streams
     * progress ticks + the PCM chunk and resolves (`await()`) with the run stats.
     */
    run(caption: string, opts?: GenerateOptions): Promise<QvacResponse<AudiogenOutputChunk>>;
    /**
     * Start a source-driven edit pipeline. Flow-Edit and Repaint operations may
     * be repeated and are executed in the exact order in which they are chained.
     * Flow-Edit is turbo DiT only (`turbo-q4`, `turbo-q8`).
     */
    edit(source: AudioEditSource): AudioEditSession;
    private _runEdit;
    private _admitAndWait;
    private _createJobData;
    cancel(): Promise<void>;
    private _cancelActiveResponse;
    unload(): Promise<void>;
    destroy(): Promise<void>;
    private _stop;
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
    private _lifecycleError;
    private _failedCancelError;
}
export { REGISTRY_SOURCE, REGISTRY_PREFIX, FIXED_MODELS, DIT_VARIANTS, DEFAULT_DIT_VARIANT, ditVariants, ditFilename, registryPath, modelFilenames, modelManifest, modelSources, resolveDitModelPath, allRegistryPaths } from './models';
export type { DitVariant, ModelManifest, ModelSources, ResolveDitModelPathOptions } from './models';
export { encodePcm, pcmToWav, SUPPORTED_FORMATS as OUTPUT_FORMATS } from './lib/audio-format';
export type { OutputFormat, EncodeOptions, EncodedAudio } from './lib/audio-format';
export { ERR_CODE_RANGE, ERR_CODES, QvacErrorAudioGen } from './error';
export { AudioEditOperationType, RepaintMode } from './audiogen';
export type { AudioGenConfigurationParams, AudioGenJobData, AudioGenBinding, AudioGenOutputCallback } from './audiogen';
