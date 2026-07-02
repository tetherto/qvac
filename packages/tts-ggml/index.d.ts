import type QvacResponse from '@qvac/infer-base/src/QvacResponse'

/**
 * Model file paths for the GGML TTS backend.  Engine is auto-detected
 * from these fields (chatterbox vs supertonic) unless overridden via
 * `TTSGgmlOptions.engine`.  All paths must be absolute (passed through
 * to the native layer as-is).
 */
declare interface TTSGgmlFiles {
  /**
   * Bundle root.  For Chatterbox, expected to contain
   * `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` (turbo) or
   * `chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf` (multilingual).
   * For Supertonic, expected to contain `supertonic.gguf`.
   */
  modelDir?: string
  /** Chatterbox T3 (text -> speech tokens) GGUF path. Overrides `modelDir`. */
  t3Model?: string
  t3ModelPath?: string
  t3?: string
  /** Chatterbox S3Gen + HiFT (speech tokens -> 24 kHz wav) GGUF path. Overrides `modelDir`. */
  s3genModel?: string
  s3genModelPath?: string
  s3gen?: string
  /** Supertonic single-file GGUF path. Overrides `modelDir`. */
  supertonicModel?: string
  supertonicModelPath?: string
  supertonic?: string
  /**
   * LavaSR enhancer GGUF: single-file Vocos bandwidth extension produced by
   * tts-cpp/scripts/convert-lavasr-enhancer-to-gguf.py. When supplied, output
   * is neurally upsampled to 48 kHz (the canonical way to enable enhancement;
   * `enhancer.enhancerPath` is the only alternative).
   */
  lavasrEnhancer?: string
  /** Optional directory containing baked Chatterbox voice profiles. */
  voicesDir?: string
  /**
   * Chatterbox MTL only: directory holding the compiled MeCab/IPAdic
   * dictionary (char.bin/matrix.bin/sys.dic/unk.dic/dicrc/mecabrc) used
   * for Japanese ("ja") morphological segmentation.  Forwarded to
   * tts-cpp's `EngineOptions::mecab_dict_path`.  Other languages ignore
   * it.  Alias: top-level `mecabDictPath`.
   */
  mecabDictDir?: string
  mecabDictPath?: string
  /**
   * Chatterbox MTL only: path to the Cangjie TSV used for Chinese
   * ("zh") romanisation.  Forwarded to tts-cpp's
   * `EngineOptions::cangjie_tsv_path`.
   */
  cangjieTsvPath?: string
  cangjieTsv?: string
}

declare interface TTSGgmlRuntimeConfig {
  /** Language code; default "en". Chatterbox MTL accepts es/fr/de/pt/it/zh/ja/ko/... */
  language?: string
  /** Route inference through a GPU backend (Metal / Vulkan / OpenCL) if available.  Defaults to `false` for both engines (opt-in via `useGPU: true` on GPU-capable hosts).  Honored on Apple (Metal), desktop (Vulkan), and Android (Vulkan/OpenCL), where tts-cpp selects the backend per its per-vendor allowlist (Chatterbox falls back to CPU on Mali). */
  useGPU?: boolean
  /**
   * Desired output sample rate in Hz (8000-192000); omit to keep the engine's
   * native rate. Resamples the native output (24 kHz Chatterbox, 44.1 kHz
   * Supertonic) — or, when the LavaSR enhancer is active, the 48 kHz enhanced
   * signal — to this rate before emitting. `TTSOutputChunk.sampleRate` reports
   * the resulting rate.
   */
  outputSampleRate?: number
}

/**
 * LavaSR enhancer config. The discriminated `type` leaves room for future
 * enhancer kinds; v1 ships `lavasr`. Enhancement is enabled by providing a
 * GGUF path (here as `enhancerPath`, or via `files.lavasrEnhancer`) — there is
 * no separate on/off flag.
 */
declare interface LavaSREnhancerOptions {
  type: 'lavasr'
  /** Enhancer GGUF path (alternative to `files.lavasrEnhancer`). */
  enhancerPath?: string
}

declare interface TTSGgmlOptions {
  files?: TTSGgmlFiles
  config?: TTSGgmlRuntimeConfig
  logger?: object
  lazySessionLoading?: boolean
  /** Explicit engine selection ('chatterbox' | 'supertonic').  Auto-detected from `files` when omitted. */
  engine?: 'chatterbox' | 'supertonic'
  /** Chatterbox: voice-cloning reference audio path (wav). */
  referenceAudio?: string
  /** Chatterbox: directory of baked voice-conditioning tensors. */
  voiceDir?: string
  /** RNG seed for CFM initial noise + SineGen excitation (Chatterbox) / vector-estimator latent (Supertonic). */
  seed?: number
  /** Move N layers to the GPU backend.  Chatterbox: pass 99 to move everything.  Supertonic: pass 99 to offload on GPU-capable hosts (including Android, per tts-cpp's per-vendor allowlist). */
  nGpuLayers?: number
  /** Chatterbox-only: cap on the T3 context length (prompt + generated speech tokens, 25 tokens ~= 1 s of audio).  The KV cache is allocated up-front at this length, so the cap directly bounds memory: the Turbo GGUF's native n_ctx=8196 costs ~1.6 GB of f32 KV, while the defaults (nCtx=4096 + kvCacheType "f16") cost ~390 MB for ~160 s of audio per synthesis call.  Pass 0 to use the GGUF's full context; negative values are rejected. */
  nCtx?: number
  /** Chatterbox-only: T3 KV-cache storage dtype: 'f32' | 'f16' | 'q8_0' (default 'f16', ~50% of f32's memory; the safe cross-backend default).  'q8_0' is ~27% of f32 and decodes 20-30% faster on Metal, but only works on backends that implement the q8_0 CONT op (CPU, CUDA) — it hard-aborts the multilingual model on Metal, so it is opt-in.  Pass 'f32' for bit-exact parity with the pre-quantisation behaviour. */
  kvCacheType?: 'f32' | 'f16' | 'q8_0'
  /** Override `std::thread::hardware_concurrency()`. */
  threads?: number
  /** Chatterbox-only: speech tokens per native streaming chunk (25 ~= 1 s of audio).  0 disables. */
  streamChunkTokens?: number
  /** Chatterbox-only: smaller first chunk for low first-audio-out latency. */
  streamFirstChunkTokens?: number
  /** Chatterbox-only: CFM Euler step count (1 halves cost; 2 matches Python meanflow). */
  cfmSteps?: number
  /** Supertonic: voice id baked into the GGUF (e.g. 'F1', 'F2', 'M1', 'M2'). */
  voice?: string
  /** Alias for `voice` (cross-compat with `@qvac/tts-onnx`). */
  voiceName?: string
  /** Supertonic: number of vector-estimator (CFM) steps.  0 -> GGUF default. */
  steps?: number
  /** Alias for `steps` (cross-compat with `@qvac/tts-onnx`). */
  numInferenceSteps?: number
  /**
   * Speech-rate / duration multiplier (1.0 = unchanged, &lt; 1 slower, &gt; 1 faster).
   * Supertonic: scales the engine's native duration predictor (0 -> GGUF default).
   * Chatterbox: the engine has no native rate control, so this is applied as a
   * pitch-preserving WSOLA time-stretch post-synthesis (functionally equivalent to
   * ffmpeg `atempo`); bounded to [0.25, 4.0].  When omitted (or 1.0), the raw
   * model output is left unchanged (no default slowdown); pass an explicit value
   * to opt in.
   */
  speed?: number
  /** Supertonic: optional path to a .npy initial-noise tensor (byte-exact reference reproduction). */
  noiseNpyPath?: string
  /**
   * LavaSR neural speech enhancement. Opt-in CPU/GGML bandwidth extension to
   * 48 kHz applied after synthesis; enabled by providing a GGUF path (here via
   * `enhancerPath` or through `files.lavasrEnhancer`). Works for Supertonic and
   * Chatterbox, including Chatterbox native chunk streaming
   * (`streamChunkTokens`), where it enhances each chunk seam-free at the cost
   * of ~0.34 s of look-ahead latency. The denoiser stage is a planned
   * follow-up.
   */
  enhancer?: LavaSREnhancerOptions
  /** Directory the addon scans for dynamically-loaded ggml backends */
  backendsDir?: string
  /** Directory where ggml-opencl persists its compiled program-binary */
  openclCacheDir?: string
  /** Chatterbox MTL only: MeCab/IPAdic dictionary dir for Japanese ("ja"). Alias of `files.mecabDictDir`. */
  mecabDictPath?: string
  /** Chatterbox MTL only: Cangjie TSV for Chinese ("zh"). Alias of `files.cangjieTsvPath`. */
  cangjieTsvPath?: string
  opts?: object
  exclusiveRun?: boolean
}

/**
 * GGML-backed TTS via the `tts-cpp` library.  Wraps both
 * `tts_cpp::chatterbox::Engine` and `tts_cpp::supertonic::Engine` behind
 * a single engine-agnostic JS surface.  Engine type is auto-detected
 * from `files` (chatterbox-* gguf vs supertonic.gguf) or set explicitly
 * via the `engine` option.
 *
 * Owns a persistent native Engine: model weights and any voice-
 * conditioning tensors are loaded once at `load()` and reused across
 * every `run()` / `runStream()` / `runStreaming()` call.
 */
declare class TTSGgml {
  constructor(options?: TTSGgmlOptions)

  static readonly ENGINE_CHATTERBOX: 'chatterbox'
  static readonly ENGINE_SUPERTONIC: 'supertonic'

  load(...args: unknown[]): Promise<void>
  unload(): Promise<void>
  destroy(): Promise<void>
  reload(newConfig?: Record<string, unknown>): Promise<void>
  cancel(): Promise<void>
  getApiDefinition(): string
  getState(): { configLoaded: boolean; weightsLoaded: boolean; destroyed: boolean }
  getEngineType(): 'chatterbox' | 'supertonic'

  opts: object
  exclusiveRun: boolean
  logger: object
  state: { configLoaded: boolean; weightsLoaded: boolean; destroyed: boolean }
  addon: unknown

  /**
   * Run text-to-speech. With `{ streamOutput: true }`, splits `input` into chunks and emits PCM on `onUpdate` per chunk.
   */
  run(
    input: TTSGgml.TTSRunInput & { streamOutput: true },
  ): Promise<QvacResponse<TTSGgml.TTSOutputChunk & TTSGgml.SentenceStreamChunkMeta>>

  run(input: TTSGgml.TTSRunInput): Promise<QvacResponse<TTSGgml.TTSOutputChunk>>

  /**
   * Chunked streaming synthesis: forwards to `run({ input: text, streamOutput: true, ... })`.
   */
  runStream(
    text: string,
    options?: TTSGgml.SentenceStreamOptions,
  ): Promise<QvacResponse<TTSGgml.TTSOutputChunk & TTSGgml.SentenceStreamChunkMeta>>

  /**
   * Streaming text in, streaming audio out. Each flushed string is one native job; PCM on `onUpdate`.
   * For `AsyncIterable` inputs, `accumulateSentences` defaults true (coalesce small streamed fragments).
   */
  runStreaming(
    textStream: TTSGgml.TextStreamInput,
    options?: TTSGgml.RunStreamingOptions,
  ): Promise<QvacResponse<TTSGgml.TTSOutputChunk & TTSGgml.SentenceStreamChunkMeta>>
}

declare namespace TTSGgml {
  export interface RuntimeStats {
    totalTime: number
    tokensPerSecond: number
    realTimeFactor: number
    audioDurationMs: number
    totalSamples: number
    /** Active compute device after the load-time backend cascade.  0 = CPU, 1 = GPU. */
    backendDevice?: number
    /** Stable numeric code for the active backend.  0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other-GPU. */
    backendId?: number
    /** 1 when a GPU was present but the engine routed to CPU by policy (e.g. Chatterbox on ARM Mali, `allow_arm_mali=false`); 0 otherwise.  A CPU `backendDevice` with `gpuUnsupported === 1` is expected, not a regression. */
    gpuUnsupported?: number
  }

  export interface TTSOutputChunk {
    outputArray: ArrayBuffer
    /**
     * Output sample rate. The native engine rate (24000 for Chatterbox,
     * 44100 for Supertonic) — or 48000 when the LavaSR enhancer is active,
     * which neurally upsamples the output regardless of engine.
     */
    sampleRate?: number
  }

  export interface SentenceStreamChunkMeta {
    chunkIndex?: number
    sentenceChunk?: string
    /** True on the final chunk of a pre-chunked synthesis (`runStream` / `run({ streamOutput: true })`).  Undefined for async-iterator streaming where the count isn't known up-front. */
    isLast?: boolean
  }

  export interface SentenceStreamOptions {
    /** BCP-47 locale for Intl.Segmenter when available. */
    locale?: string
    /** Max graphemes per chunk (defaults: 300, or 120 when language is ko). */
    maxChunkScalars?: number
  }

  /** Input accepted by `runStreaming`. */
  export type TextStreamInput =
    | string
    | string[]
    | Iterable<string>
    | AsyncIterable<string>

  export interface RunStreamingOptions {
    accumulateSentences?: boolean
    sentenceDelimiter?: RegExp
    sentenceDelimiterPreset?: 'latin' | 'cjk' | 'multilingual'
    maxBufferScalars?: number
    flushAfterMs?: number
  }

  export type TTSRunInput = {
    type?: string
    input: string
    streamOutput?: boolean
    locale?: string
    maxChunkScalars?: number
    outputSampleRate?: number
  }

  export {
    TTSGgml as default,
    TTSGgmlFiles,
    TTSGgmlOptions,
    LavaSREnhancerOptions,
    TTSGgmlRuntimeConfig,
    RuntimeStats,
    SentenceStreamChunkMeta,
    SentenceStreamOptions,
    RunStreamingOptions,
    TextStreamInput,
    TTSOutputChunk,
    TTSRunInput
  }
}

export = TTSGgml
