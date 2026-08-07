import { type QvacResponse } from "@qvac/infer-base";
import { type SentenceDelimiterPreset } from "./lib/textStreamAccumulator";
declare const ENGINE_CHATTERBOX = "chatterbox";
declare const ENGINE_SUPERTONIC = "supertonic";
declare const ENGINE_COSYVOICE3 = "cosyvoice3";
declare const ENGINE_PARLER = "parler";
declare const COSYVOICE_DIALECTS: {
    readonly cantonese: "广东话";
    readonly northeastern: "东北话";
    readonly gansu: "甘肃话";
    readonly guizhou: "贵州话";
    readonly henan: "河南话";
    readonly hubei: "湖北话";
    readonly hunan: "湖南话";
    readonly jiangxi: "江西话";
    readonly minnan: "闽南话";
    readonly ningxia: "宁夏话";
    readonly shanxi: "山西话";
    readonly shaanxi: "陕西话";
    readonly shandong: "山东话";
    readonly shanghai: "上海话";
    readonly sichuan: "四川话";
    readonly tianjin: "天津话";
    readonly yunnan: "云南话";
};
declare const COSYVOICE_EMOTIONS: {
    readonly happy: "请非常开心地说一句话。";
    readonly sad: "请非常伤心地说一句话。";
    readonly angry: "请非常生气地说一句话。";
};
declare const COSYVOICE_SPEEDS: {
    readonly slow: "请用尽可能慢地语速说一句话。";
    readonly fast: "请用尽可能快地语速说一句话。";
};
declare const COSYVOICE_VOLUMES: {
    readonly loud: "Please say a sentence as loudly as possible.";
    readonly soft: "Please say a sentence in a very soft voice.";
};
declare const COSYVOICE_STYLES: {
    readonly peppa: "我想体验一下小猪佩奇风格，可以吗？";
    readonly robot: "你可以尝试用机器人的方式解答吗？";
};
/**
 * Structured CosyVoice3 control. Exactly one field takes effect per synthesis,
 * resolved by precedence dialect > emotion > speed > volume > style. Pass a raw
 * string instead for an arbitrary instruction (advanced escape hatch).
 */
interface CosyvoiceInstruct {
    /** Chinese dialect; renders "请用{dialect}表达。". */
    dialect?: keyof typeof COSYVOICE_DIALECTS;
    /** Emotion. */
    emotion?: keyof typeof COSYVOICE_EMOTIONS;
    /** Speaking speed. */
    speed?: keyof typeof COSYVOICE_SPEEDS;
    /** Loudness. */
    volume?: keyof typeof COSYVOICE_VOLUMES;
    /** Playful style preset. */
    style?: keyof typeof COSYVOICE_STYLES;
}
type EngineType = typeof ENGINE_CHATTERBOX | typeof ENGINE_SUPERTONIC | typeof ENGINE_COSYVOICE3 | typeof ENGINE_PARLER;
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
    /** Parler single-file GGUF path (mini/large/indic). Overrides `modelDir`. */
    parlerModel?: string;
    parlerModelPath?: string;
    parler?: string;
    /**
     * CosyVoice3 model directory holding the sub-model GGUFs
     * (`cosyvoice3-{llm,flow,hift}-*.gguf`) plus `voice.gguf`, `vocab.json` and
     * `merges.txt`. Routes to the CosyVoice3 engine. Falls back to the shared
     * `modelDir` when unset.
     */
    cosyvoiceModelDir?: string;
    /** CosyVoice3 per-component GGUF paths (override discovery under the model dir). */
    cosyvoiceLlmModel?: string;
    cosyvoiceLlmModelPath?: string;
    cosyvoiceFlowModel?: string;
    cosyvoiceFlowModelPath?: string;
    cosyvoiceHiftModel?: string;
    cosyvoiceHiftModelPath?: string;
    cosyvoiceS3tokModel?: string;
    cosyvoiceS3tokModelPath?: string;
    cosyvoiceCampplusModel?: string;
    cosyvoiceCampplusModelPath?: string;
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
    /**
     * Language code; default "en". Chatterbox MTL accepts
     * es/fr/de/pt/it/zh/ja/ko/... CosyVoice3: reserved / not yet effective — the
     * text-normalization frontend is not yet integrated, so it is accepted but
     * not acted on.
     */
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
     * native rate. Resamples the native output (24 kHz Chatterbox and
     * CosyVoice3, 44.1 kHz Supertonic), or the 48 kHz LavaSR-enhanced signal,
     * before emitting. `TTSOutputChunk.sampleRate` reports the resulting rate.
     *
     * CosyVoice3 native chunk streaming emits at 24 kHz: a different rate is
     * only accepted there when the LavaSR enhancer is active, because the
     * enhancer's overlap-reprocess window resamples without chunk seams.
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
/**
 * Parler voice-description inputs. Either a free-text `description` (alias
 * `voiceDescription`) or the template fields, rendered natively through
 * tts-cpp's build_description(); mixing the two at the same level is rejected.
 * Accepted at construction, on `reload()`, and per call (Parler only).
 */
interface ParlerDescriptionFields {
    description?: string;
    voiceDescription?: string;
    /** Parler voice-template field; also Supertonic's baked voice id. */
    voice?: string;
    emotion?: string;
    pitch?: string;
    pace?: string;
    expressivity?: string;
    noise?: string;
    reverb?: string;
    quality?: string;
}
interface TTSGgmlOptions extends ParlerDescriptionFields {
    files?: TTSGgmlFiles;
    config?: TTSGgmlRuntimeConfig;
    logger?: object;
    lazySessionLoading?: boolean;
    /** Explicit engine selection. Auto-detected from `files` when omitted. */
    engine?: EngineType;
    /**
     * Chatterbox: voice-cloning reference audio path (wav). CosyVoice3: reserved
     * / not yet effective — zero-shot cloning needs the native S3 tokenizer +
     * CAM++ (not ported yet), so the engine falls back to the baked voice.
     */
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
    /**
     * Chatterbox / CosyVoice3 speech tokens per native streaming chunk.
     * 0 disables.
     */
    streamChunkTokens?: number;
    /**
     * Chatterbox / CosyVoice3 smaller first chunk for low first-audio-out
     * latency.
     */
    streamFirstChunkTokens?: number;
    /** CosyVoice3-only: left-context speech tokens carried into each streaming chunk. */
    streamLeftContextTokens?: number;
    /**
     * Chatterbox-only CFM Euler step count. CosyVoice3: reserved / not yet
     * effective — the engine runs a fixed 10-step schedule and ignores this.
     */
    cfmSteps?: number;
    /**
     * Chatterbox-only S3Gen classifier-free-guidance rate. The diffusion loop
     * normally runs a batched conditioned + unconditioned pass combined by this
     * rate. `0` skips the unconditioned pass; a positive value overrides the
     * model's baked rate. Omit it to retain the baked rate.
     */
    cfgRate?: number;
    /** CosyVoice3: transcript of `referenceAudio` for zero-shot voice cloning (conditions the LM prompt). */
    promptText?: string;
    /**
     * CosyVoice3: natural-language control (instruct2) — Chinese dialect, emotion,
     * speed, volume, or style. Pass a structured object (e.g. `{ dialect:
     * 'cantonese' }`, `{ emotion: 'happy' }`) which renders to the trained
     * instruction, or a raw string for an arbitrary instruction. Applied on top of
     * the selected voice's timbre; one control takes effect per synthesis.
     */
    instruct?: string | CosyvoiceInstruct;
    /**
     * Supertonic voice id baked into the GGUF, such as `F1` or `M1`. CosyVoice3:
     * reserved / not yet effective — named-voice selection is not yet wired.
     */
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
     * Works for every engine, including the native chunk streaming of
     * Chatterbox, Parler and CosyVoice3.
     */
    enhancer?: LavaSREnhancerOptions;
    /**
     * LavaSR neural speech denoiser (UL-UNAS). Opt-in preprocessing that runs
     * before the enhancer and preserves the sample rate. Enabled by a GGUF path
     * here or through `files.lavasrDenoiser`; rejected with native chunk
     * streaming (batch synthesis only).
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
    /**
     * Parler sampling / generation knobs; each unset defers to the GGUF's
     * generation defaults (temperature 1.0, top-k 50, ~30 s max length).
     */
    temperature?: number;
    topK?: number;
    topP?: number;
    /** Parler generation-length cap in decoder steps (~86/s); 0 = model default. */
    maxFrames?: number;
    minNewTokens?: number;
    /** Parler prompt digit expansion (engine default: enabled). */
    normalizeNumbers?: boolean;
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
     * 44100 for Supertonic and Parler), or 48000 when the LavaSR enhancer is
     * active.
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
interface SentenceStreamOptions extends ParlerDescriptionFields {
    /** BCP-47 locale for `Intl.Segmenter` when available. */
    locale?: string;
    /** Maximum graphemes per chunk; defaults to 300, or 120 for Korean. */
    maxChunkScalars?: number;
}
interface RunStreamingOptions extends ParlerDescriptionFields {
    accumulateSentences?: boolean;
    sentenceDelimiter?: RegExp;
    sentenceDelimiterPreset?: SentenceDelimiterPreset;
    maxBufferScalars?: number;
    flushAfterMs?: number;
}
/** Input accepted by `runStreaming`. */
type TextStreamInput = string | string[] | Iterable<string> | AsyncIterable<string>;
interface TTSRunInput extends ParlerDescriptionFields {
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
    static readonly ENGINE_COSYVOICE3 = "cosyvoice3";
    static readonly ENGINE_PARLER = "parler";
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
    private _cosyvoiceModelDir?;
    private _cosyvoiceLlmModelPath?;
    private _cosyvoiceFlowModelPath?;
    private _cosyvoiceHiftModelPath?;
    private _cosyvoiceS3tokModelPath?;
    private _cosyvoiceCampplusModelPath?;
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
    private _streamLeftContextTokens?;
    private _cfmSteps?;
    private _cfgRate?;
    private _promptText?;
    private _instruct?;
    private _voice?;
    private _steps?;
    private _speed?;
    private _noiseNpyPath?;
    private _enhancerGgufPath?;
    private _denoiserGgufPath?;
    private _backendsDir?;
    private _openclCacheDir?;
    private _vulkanCacheDir?;
    private _parlerModelPath?;
    private _description?;
    private _emotion?;
    private _pitch?;
    private _pace?;
    private _expressivity?;
    private _noise?;
    private _reverb?;
    private _quality?;
    private _temperature?;
    private _topK?;
    private _topP?;
    private _maxFrames?;
    private _minNewTokens?;
    private _normalizeNumbers?;
    constructor(options?: TTSGgmlOptions);
    private _resolveEngineAndModelPaths;
    private _assignSynthesisOptions;
    private _assertEngineStreamingSupport;
    private _requestsChunkStreaming;
    private _assertParlerOptionConsistency;
    private _assertCosyvoiceOptionConsistency;
    /**
     * Extract + validate the per-call parler description/template fields from a
     * run input or streaming options. Returns undefined when none are present.
     * Parler-only; a per-call template cannot be merged with a constructor-level
     * free-text description.
     */
    private _resolveParlerJobFields;
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
    private _buildCosyvoiceParams;
    private _buildChatterboxParams;
    private _buildSupertonicParams;
    private _buildParlerParams;
    private _assignCommonNativeParams;
    /** LavaSR post-processing paths, shared by every engine that supports them. */
    private _assignLavasrParams;
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
type NamespaceCosyvoiceInstruct = CosyvoiceInstruct;
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
    type CosyvoiceInstruct = NamespaceCosyvoiceInstruct;
}
export = TTSGgml;
