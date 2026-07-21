import { type QvacResponse } from "@qvac/infer-base";
import { type SentenceDelimiterPreset } from "./lib/textStreamAccumulator";
declare const ENGINE_CHATTERBOX = "chatterbox";
declare const ENGINE_SUPERTONIC = "supertonic";
type EngineType = typeof ENGINE_CHATTERBOX | typeof ENGINE_SUPERTONIC;
/**
 * Model file paths for the GGML TTS backend. Engine is auto-detected
 * from these fields (Chatterbox vs Supertonic) unless overridden via
 * `TTSGgmlOptions.engine`. All paths must be absolute and are passed
 * through to the native layer as-is.
 */
interface TTSGgmlFiles {
    /**
     * Bundle root. For Chatterbox, expected to contain
     * `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` (turbo) or
     * `chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf` (multilingual).
     * For Supertonic, expected to contain `supertonic.gguf`.
     */
    modelDir?: string;
    /** Chatterbox T3 (text to speech tokens) GGUF path. Overrides `modelDir`. */
    t3Model?: string;
    t3ModelPath?: string;
    t3?: string;
    /** Chatterbox S3Gen + HiFT (speech tokens to 24 kHz wav) GGUF path. Overrides `modelDir`. */
    s3genModel?: string;
    s3genModelPath?: string;
    s3gen?: string;
    /** Supertonic single-file GGUF path. Overrides `modelDir`. */
    supertonicModel?: string;
    supertonicModelPath?: string;
    supertonic?: string;
    /**
     * LavaSR enhancer GGUF: single-file Vocos bandwidth extension produced by
     * tts-cpp/scripts/convert-lavasr-enhancer-to-gguf.py. When supplied, output
     * is neurally upsampled to 48 kHz (the canonical way to enable enhancement;
     * `enhancer.enhancerPath` is the only alternative).
     */
    lavasrEnhancer?: string;
    /**
     * LavaSR denoiser GGUF: UL-UNAS speech denoiser produced by
     * tts-cpp/scripts/convert-lavasr-denoiser-to-gguf.py. Runs before the
     * enhancer and is rate-preserving (the canonical way to enable denoising;
     * `denoiser.denoiserPath` is the only alternative).
     *
     * The tts-cpp UL-UNAS forward is implemented in qvac-ext-lib-whisper.cpp
     * PR #78 (scalar CPU port, validated bit-close to the ONNX reference).
     */
    lavasrDenoiser?: string;
    /** Optional directory containing baked Chatterbox voice profiles. */
    voicesDir?: string;
    /**
     * Chatterbox MTL only: directory holding the compiled MeCab/IPAdic
     * dictionary used for Japanese morphological segmentation. Forwarded to
     * tts-cpp's `EngineOptions::mecab_dict_path`. Alias: top-level
     * `mecabDictPath`.
     */
    mecabDictDir?: string;
    mecabDictPath?: string;
    /**
     * Chatterbox MTL only: path to the Cangjie TSV used for Chinese
     * romanisation. Forwarded to tts-cpp's `EngineOptions::cangjie_tsv_path`.
     */
    cangjieTsvPath?: string;
    cangjieTsv?: string;
}
interface TTSGgmlRuntimeConfig {
    /** Language code; default "en". Chatterbox MTL accepts es/fr/de/pt/it/zh/ja/ko/... */
    language?: string;
    /**
     * Route inference through a GPU backend (Metal / Vulkan / OpenCL) if
     * available. Defaults to `false` for both engines. Honored on Apple,
     * desktop, and Android, where tts-cpp selects the backend using its
     * per-vendor allowlist.
     */
    useGPU?: boolean;
    /**
     * Desired output sample rate in Hz (8000-192000); omit to keep the engine's
     * native rate. Resamples the native output (24 kHz Chatterbox, 44.1 kHz
     * Supertonic), or the 48 kHz LavaSR-enhanced signal, before emitting.
     * `TTSOutputChunk.sampleRate` reports the resulting rate.
     */
    outputSampleRate?: number;
    backendsDir?: string;
    openclCacheDir?: string;
    vulkanCacheDir?: string;
}
/**
 * LavaSR enhancer config. The discriminated `type` leaves room for future
 * enhancer kinds; v1 ships `lavasr`. Enhancement is enabled by providing a
 * GGUF path here or via `files.lavasrEnhancer`.
 */
interface LavaSREnhancerOptions {
    type: "lavasr";
    /** Enhancer GGUF path (alternative to `files.lavasrEnhancer`). */
    enhancerPath?: string;
}
/**
 * LavaSR denoiser config. V1 ships the `lavasr` UL-UNAS denoiser. Denoising
 * is enabled by providing a GGUF path here or via `files.lavasrDenoiser`.
 * It runs before the enhancer and preserves the sample rate.
 */
interface LavaSRDenoiserOptions {
    type: "lavasr";
    /** Denoiser GGUF path (alternative to `files.lavasrDenoiser`). */
    denoiserPath?: string;
}
interface TTSGgmlOptions {
    files?: TTSGgmlFiles;
    config?: TTSGgmlRuntimeConfig;
    logger?: object;
    lazySessionLoading?: boolean;
    /** Explicit engine selection. Auto-detected from `files` when omitted. */
    engine?: EngineType;
    /** Chatterbox: voice-cloning reference audio path (wav). */
    referenceAudio?: string;
    /** Chatterbox: directory of baked voice-conditioning tensors. */
    voiceDir?: string;
    /** RNG seed for Chatterbox CFM/SineGen or Supertonic latent generation. */
    seed?: number;
    /**
     * Move N layers to the GPU backend. Chatterbox: pass 99 to move everything.
     * Supertonic: pass 99 to offload on GPU-capable hosts, including Android.
     */
    nGpuLayers?: number;
    /**
     * Chatterbox-only cap on the T3 context length (prompt + generated speech
     * tokens, 25 tokens ~= 1 second of audio). The KV cache is allocated up
     * front at this length, so the cap directly bounds memory. Pass 0 to use
     * the GGUF's full context; negative values are rejected.
     */
    nCtx?: number;
    /**
     * Chatterbox-only T3 KV-cache storage dtype: `f32` | `f16` | `q8_0`.
     * `f16` is the safe cross-backend default. `q8_0` is smaller and faster on
     * supported backends, but is opt-in because not every backend implements
     * its required operations.
     */
    kvCacheType?: "f32" | "f16" | "q8_0";
    /** Override `std::thread::hardware_concurrency()`. */
    threads?: number;
    /** Chatterbox-only speech tokens per native streaming chunk. 0 disables. */
    streamChunkTokens?: number;
    /** Chatterbox-only smaller first chunk for low first-audio-out latency. */
    streamFirstChunkTokens?: number;
    /** Chatterbox-only CFM Euler step count. */
    cfmSteps?: number;
    /**
     * Chatterbox-only S3Gen classifier-free-guidance rate. The diffusion loop
     * normally runs a batched conditioned + unconditioned pass combined by this
     * rate. `0` skips the unconditioned pass; a positive value overrides the
     * model's baked rate. Omit it to retain the baked rate.
     */
    cfgRate?: number;
    /** Supertonic voice id baked into the GGUF, such as `F1` or `M1`. */
    voice?: string;
    /** Alias for `voice` for compatibility with `@qvac/tts-onnx`. */
    voiceName?: string;
    /** Supertonic vector-estimator CFM steps. 0 uses the GGUF default. */
    steps?: number;
    /** Alias for `steps` for compatibility with `@qvac/tts-onnx`. */
    numInferenceSteps?: number;
    /**
     * Speech-rate / duration multiplier (1.0 = unchanged, less than 1 slower,
     * greater than 1 faster). Supertonic scales its native duration predictor.
     * Chatterbox applies pitch-preserving WSOLA time-stretch, bounded to
     * [0.25, 4.0].
     */
    speed?: number;
    /** Supertonic optional `.npy` initial-noise tensor path. */
    noiseNpyPath?: string;
    /**
     * LavaSR neural speech enhancement. Opt-in CPU/GGML bandwidth extension to
     * 48 kHz, enabled by a GGUF path here or through `files.lavasrEnhancer`.
     * Works for both engines, including Chatterbox native chunk streaming.
     */
    enhancer?: LavaSREnhancerOptions;
    /**
     * LavaSR neural speech denoiser (UL-UNAS). Opt-in preprocessing that runs
     * before the enhancer and preserves the sample rate. Enabled by a GGUF path
     * here or through `files.lavasrDenoiser`; rejected with Chatterbox native
     * chunk streaming.
     */
    denoiser?: LavaSRDenoiserOptions;
    /** Directory the addon scans for dynamically loaded ggml backends. */
    backendsDir?: string;
    /** Directory where ggml-opencl persists its compiled program binary. */
    openclCacheDir?: string;
    /**
     * Supertonic + `useGPU: true` only: directory where the Vulkan backend
     * persists its compiled pipeline cache (`GGML_VK_PIPELINE_CACHE_DIR`).
     * Unset means no cross-process cache or load-time pre-warm.
     */
    vulkanCacheDir?: string;
    /** Chatterbox MTL MeCab/IPAdic dictionary directory for Japanese. */
    mecabDictPath?: string;
    mecabDictDir?: string;
    /** Chatterbox MTL Cangjie TSV path for Chinese. */
    cangjieTsvPath?: string;
    opts?: object;
    exclusiveRun?: boolean;
}
interface InferenceState {
    configLoaded: boolean;
    weightsLoaded: boolean;
    destroyed: boolean;
}
interface TTSOutputChunk {
    /** PCM audio payload. Kept as `ArrayBuffer` for public API compatibility. */
    outputArray: ArrayBuffer;
    /**
     * Output sample rate. The native engine rate (24000 for Chatterbox,
     * 44100 for Supertonic), or 48000 when the LavaSR enhancer is active.
     */
    sampleRate?: number;
}
interface RuntimeStats {
    totalTime: number;
    tokensPerSecond: number;
    realTimeFactor: number;
    audioDurationMs: number;
    totalSamples: number;
    /** Active compute device after load-time backend selection. 0 = CPU, 1 = GPU. */
    backendDevice?: number;
    /** Stable backend code: 0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other GPU. */
    backendId?: number;
    /** 1 when a present GPU is unsupported by engine policy; 0 otherwise. */
    gpuUnsupported?: number;
}
interface SentenceStreamChunkMeta {
    chunkIndex?: number;
    sentenceChunk?: string;
    /**
     * True on the final pre-chunked synthesis output. Undefined for async
     * iterator streaming where the final chunk is not known up front.
     */
    isLast?: boolean;
}
interface SentenceStreamOptions {
    /** BCP-47 locale for `Intl.Segmenter` when available. */
    locale?: string;
    /** Maximum graphemes per chunk; defaults to 300, or 120 for Korean. */
    maxChunkScalars?: number;
}
interface RunStreamingOptions {
    accumulateSentences?: boolean;
    sentenceDelimiter?: RegExp;
    sentenceDelimiterPreset?: SentenceDelimiterPreset;
    maxBufferScalars?: number;
    flushAfterMs?: number;
}
/** Input accepted by `runStreaming`. */
type TextStreamInput = string | string[] | Iterable<string> | AsyncIterable<string>;
interface TTSRunInput {
    type?: string;
    input: string;
    streamOutput?: boolean;
    locale?: string;
    maxChunkScalars?: number;
    outputSampleRate?: number;
    /**
     * Cancels non-streaming `run()`. An already-aborted signal rejects without
     * native dispatch. Ignored by all streaming paths.
     */
    signal?: AbortSignal;
}
/**
 * GGML-backed TTS via the `tts-cpp` library. Wraps both
 * `tts_cpp::chatterbox::Engine` and `tts_cpp::supertonic::Engine` behind a
 * single engine-agnostic JavaScript surface. Engine type is auto-detected
 * from `files` or selected explicitly with `engine`.
 *
 * Owns a persistent native engine: model weights and voice-conditioning
 * tensors are loaded once by `load()` and reused by `run()`, `runStream()`,
 * and `runStreaming()`.
 */
declare class TTSGgml {
    static readonly inferenceManagerConfig: {
        noAdditionalDownload: boolean;
    };
    static readonly ENGINE_CHATTERBOX = "chatterbox";
    static readonly ENGINE_SUPERTONIC = "supertonic";
    opts: object;
    exclusiveRun: boolean;
    logger: object;
    state: InferenceState;
    addon: unknown;
    private readonly _job;
    private readonly _runExclusive;
    private _ttsInferenceQueueWaiter;
    private _sentenceStreamCtx;
    private _config;
    private _lazySessionLoading;
    private _outputSampleRate;
    private _engineType;
    private _voicesDir?;
    private _supertonicModelPath?;
    private _t3ModelPath?;
    private _s3genModelPath?;
    private _mecabDictPath?;
    private _cangjieTsvPath?;
    private _referenceAudio?;
    private _voiceDir?;
    private _seed?;
    private _nGpuLayers?;
    private _nCtx?;
    private _kvCacheType?;
    private _threads?;
    private _streamChunkTokens?;
    private _streamFirstChunkTokens?;
    private _cfmSteps?;
    private _cfgRate?;
    private _voice?;
    private _steps?;
    private _speed?;
    private _noiseNpyPath?;
    private _enhancerGgufPath?;
    private _denoiserGgufPath?;
    private _backendsDir?;
    private _openclCacheDir?;
    private _vulkanCacheDir?;
    constructor(options?: TTSGgmlOptions);
    private _resolveEngineAndModelPaths;
    private _assignSynthesisOptions;
    private _assertEngineStreamingSupport;
    getEngineType(): EngineType;
    getApiDefinition(): string;
    getState(): InferenceState;
    load(..._args: unknown[]): Promise<void>;
    /**
     * Run text-to-speech. With `{ streamOutput: true }`, splits `input` into
     * chunks and emits PCM through `response.onUpdate` for each chunk.
     */
    run(input: TTSRunInput & {
        streamOutput: true;
    }): Promise<QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>>;
    run(input: TTSRunInput): Promise<QvacResponse<TTSOutputChunk>>;
    /**
     * Chunked streaming synthesis. Equivalent to
     * `run({ input: text, streamOutput: true, ...options })`.
     */
    runStream(text: string, options?: SentenceStreamOptions): Promise<QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>>;
    /**
     * Streaming text in and streaming audio out. Each flushed string is one
     * native job and emits PCM through `response.onUpdate`.
     *
     * For `AsyncIterable` inputs, `accumulateSentences` defaults to `true` so
     * small streamed fragments are coalesced.
     */
    runStreaming(textStream: TextStreamInput, options?: RunStreamingOptions): Promise<QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>>;
    private _enqueueExclusiveTtsResponse;
    private _resolveRunStreamingOptions;
    private _normalizeTextStream;
    private _runTextStreamOrchestrator;
    private _sentenceStreamTextIterableDrive;
    private _runStreamOrchestrator;
    private _sentenceStreamDriveBody;
    private _load;
    private _buildTtsParams;
    private _buildChatterboxParams;
    private _buildSupertonicParams;
    private _assignCommonNativeParams;
    private _createAddon;
    unload(): Promise<void>;
    destroy(): Promise<void>;
    private _runInternal;
    private _mergeSentenceStreamStats;
    private _rejectActiveChunk;
    private _endJobWithStats;
    private _addonOutputCallback;
    private _handleAddonError;
    private _handleAddonOutput;
    private _enrichStreamChunk;
    private _handleAddonStats;
    cancel(): Promise<void>;
    private _failAndClearActiveResponse;
    reload(newConfig?: Record<string, unknown>): Promise<void>;
    static getModelKey(_params?: unknown): string;
    private _requireAddon;
    private _optionalAddon;
    private _getLogger;
}
type NamespaceFiles = TTSGgmlFiles;
type NamespaceRuntimeConfig = TTSGgmlRuntimeConfig;
type NamespaceOptions = TTSGgmlOptions;
type NamespaceEnhancerOptions = LavaSREnhancerOptions;
type NamespaceDenoiserOptions = LavaSRDenoiserOptions;
type NamespaceRuntimeStats = RuntimeStats;
type NamespaceOutputChunk = TTSOutputChunk;
type NamespaceSentenceStreamChunkMeta = SentenceStreamChunkMeta;
type NamespaceSentenceStreamOptions = SentenceStreamOptions;
type NamespaceRunStreamingOptions = RunStreamingOptions;
type NamespaceTextStreamInput = TextStreamInput;
type NamespaceRunInput = TTSRunInput;
type NamespaceInferenceState = InferenceState;
declare namespace TTSGgml {
    type TTSGgmlFiles = NamespaceFiles;
    type TTSGgmlRuntimeConfig = NamespaceRuntimeConfig;
    type TTSGgmlOptions = NamespaceOptions;
    type LavaSREnhancerOptions = NamespaceEnhancerOptions;
    type LavaSRDenoiserOptions = NamespaceDenoiserOptions;
    type RuntimeStats = NamespaceRuntimeStats;
    type TTSOutputChunk = NamespaceOutputChunk;
    type SentenceStreamChunkMeta = NamespaceSentenceStreamChunkMeta;
    type SentenceStreamOptions = NamespaceSentenceStreamOptions;
    type RunStreamingOptions = NamespaceRunStreamingOptions;
    type TextStreamInput = NamespaceTextStreamInput;
    type TTSRunInput = NamespaceRunInput;
    type InferenceState = NamespaceInferenceState;
}
export = TTSGgml;
