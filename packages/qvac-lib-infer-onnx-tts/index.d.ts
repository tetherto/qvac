import type QvacResponse from '@qvac/infer-base/src/QvacResponse'

/**
 * LavaSR enhancer configuration.
 * Opt-in neural speech enhancement, works with any TTS engine.
 */
declare interface LavaSREnhancerConfig {
  type: 'lavasr'
  /** Run neural bandwidth extension to 48 kHz */
  enhance?: boolean
  /** Run denoiser before enhancement */
  denoise?: boolean
  /** Path to enhancer backbone ONNX model */
  backbonePath?: string
  /** Path to enhancer spec head ONNX model */
  specHeadPath?: string
  /** Path to denoiser ONNX model */
  denoiserPath?: string
}

/**
 * Enhancer configuration — currently only LavaSR is supported.
 * Future enhancers will be added as additional union members.
 */
declare type EnhancerConfig = LavaSREnhancerConfig

/**
 * Weight / config paths for ONNX TTS. Use short keys; legacy `*Path` names and
 * SDK aliases (`supertonicModel`, `latentDenoiser`, `voiceDecoder`, `supertonicVocoder`) are accepted.
 * All file paths must be absolute (passed through to the native layer as-is).
 */
declare interface ONNXTTSFiles {
  /**
   * Bundle root for either engine (same top-level option; layout differs).
   * Chatterbox: `tokenizer.json`, `speech_encoder.onnx`, … at root.
   * Supertonic: `onnx/`, `voice_styles/` (see README).
   * Per-file entries override these defaults when both are set.
   */
  modelDir?: string
  /** Chatterbox: tokenizer JSON. Supertonic explicit: may serve as unicode indexer if `unicodeIndexer` omitted. */
  tokenizer?: string
  speechEncoder?: string
  embedTokens?: string
  conditionalDecoder?: string
  languageModel?: string
  /** Alias: `supertonicModel` */
  textEncoder?: string
  supertonicModel?: string
  /** Aliases: `latentDenoiser`, `*Path` variants */
  durationPredictor?: string
  latentDenoiser?: string
  vectorEstimator?: string
  /** Aliases: `voiceDecoder`, `supertonicVocoder`, `*Path` variants */
  vocoder?: string
  voiceDecoder?: string
  supertonicVocoder?: string
  unicodeIndexer?: string
  ttsConfig?: string
  voiceStyle?: string
  /**
   * Supertonic: directory containing `{voiceName}.json` voice styles. When set with `modelDir`,
   * overrides the default `modelDir/voice_styles`. When `modelDir` is omitted, used with `voiceName`
   * if `voiceStyle` is not set.
   */
  voicesDir?: string
  tokenizerPath?: string
  speechEncoderPath?: string
  embedTokensPath?: string
  conditionalDecoderPath?: string
  languageModelPath?: string
  textEncoderPath?: string
  durationPredictorPath?: string
  latentDenoiserPath?: string
  vectorEstimatorPath?: string
  vocoderPath?: string
  voiceDecoderPath?: string
  unicodeIndexerPath?: string
  ttsConfigPath?: string
  voiceStyleJsonPath?: string
}

declare interface ONNXTTSRuntimeConfig {
  /** Language code (e.g. "en", "es") — default "en" */
  language?: string
  /** Chatterbox: GPU — default false */
  useGPU?: boolean
  /** Runtime enhancer overrides (used in reload) */
  enhancer?: EnhancerConfig
  outputSampleRate?: number
}

declare interface ONNXTTSOptions {
  files?: ONNXTTSFiles
  /**
   * Force engine when ambiguous (e.g. `files.modelDir` with no per-file paths: default is Supertonic).
   * Use `"chatterbox"` for Chatterbox-only bundle layout under `modelDir`.
   */
  engine?: 'chatterbox' | 'supertonic'
  config?: ONNXTTSRuntimeConfig
  /** Post-processing enhancer config */
  enhancer?: EnhancerConfig
  logger?: object
  lazySessionLoading?: boolean
  /** Chatterbox voice cloning input */
  referenceAudio?: Float32Array | number[]
  /** Supertonic voice id for `voice_styles/{voiceName}.json` — default `"F1"`. Optional when using `files.modelDir`. */
  voiceName?: string
  speed?: number
  numInferenceSteps?: number
  supertonicMultilingual?: boolean
  opts?: object
  exclusiveRun?: boolean
}

/**
 * ONNX client for TTS (Chatterbox or Supertonic). Prefer `files: { modelDir }` for both engines;
 * set `engine` when `modelDir` is the only file field (defaults to Supertonic for back-compat).
 * `files` paths must be absolute.
 */
declare class ONNXTTS {
  constructor(options?: ONNXTTSOptions)

  load(...args: unknown[]): Promise<void>
  unload(): Promise<void>
  destroy(): Promise<void>
  reload(newConfig?: Record<string, unknown>): Promise<void>
  cancel(): Promise<void>
  getApiDefinition(): string
  getState(): { configLoaded: boolean; weightsLoaded: boolean; destroyed: boolean }

  opts: object
  exclusiveRun: boolean
  logger: object
  state: { configLoaded: boolean; weightsLoaded: boolean; destroyed: boolean }
  addon: unknown

  /**
   * Run text-to-speech. With `{ streamOutput: true }`, splits `input` into chunks and emits PCM on `onUpdate` per chunk.
   * When `opts.stats` was set, `response.stats` matches {@link ONNXTTS.RuntimeStats}.
   */
  run(
    input: ONNXTTS.TTSRunInput & { streamOutput: true },
  ): Promise<QvacResponse<ONNXTTS.TTSOutputChunk & ONNXTTS.SentenceStreamChunkMeta>>

  run(input: ONNXTTS.TTSRunInput): Promise<QvacResponse<ONNXTTS.TTSOutputChunk>>

  /**
   * Chunked streaming synthesis: forwards to `run({ input: text, streamOutput: true, ... })`.
   */
  runStream(
    text: string,
    options?: ONNXTTS.SentenceStreamOptions,
  ): Promise<QvacResponse<ONNXTTS.TTSOutputChunk & ONNXTTS.SentenceStreamChunkMeta>>

  /**
   * Streaming text in, streaming audio out. Each flushed string is one native job; PCM on `onUpdate`.
   * For `AsyncIterable` inputs, `accumulateSentences` defaults true (coalesce small streamed fragments).
   */
  runStreaming(
    textStream: ONNXTTS.TextStreamInput,
    options?: ONNXTTS.RunStreamingOptions,
  ): Promise<QvacResponse<ONNXTTS.TTSOutputChunk & ONNXTTS.SentenceStreamChunkMeta>>
}

declare namespace ONNXTTS {
  export interface RuntimeStats {
    totalTime: number
    tokensPerSecond: number
    realTimeFactor: number
    audioDurationMs: number
    totalSamples: number
  }

  export interface TTSOutputChunk {
    outputArray: ArrayBuffer
  }

  export interface SentenceStreamChunkMeta {
    chunkIndex?: number
    sentenceChunk?: string
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
    /**
     * When true, concatenate small streamed fragments until a sentence end, max buffer size, or idle time.
     * Default: true only when `textStream` is an `AsyncIterable` (not a plain string or array).
     */
    accumulateSentences?: boolean
    /** Sentence end detection when buffer matches this pattern (overrides `sentenceDelimiterPreset`). */
    sentenceDelimiter?: RegExp
    /** Preset for built-in sentence-end patterns (ignored if `sentenceDelimiter` is set). */
    sentenceDelimiterPreset?: 'latin' | 'cjk' | 'multilingual'
    /** Max graphemes per buffered chunk before a forced flush (aligned with `splitTtsText` defaults by language). */
    maxBufferScalars?: number
    /** Idle time after the last fragment before flushing the buffer (timer resets on each fragment). Default 500. */
    flushAfterMs?: number
  }

  export type TTSRunInput = {
    type?: string
    input: string
    /**
     * When true, sentence-chunk synthesis with streamed `onUpdate` (same behavior as `runStream`).
     * Optional `locale` and `maxChunkScalars` apply in this mode.
     */
    streamOutput?: boolean
    /** With `streamOutput: true`: BCP-47 locale for Intl.Segmenter when available. */
    locale?: string
    /** With `streamOutput: true`: max graphemes per chunk (defaults: 300, or 120 when language is ko). */
    maxChunkScalars?: number
    /** Per-job enhancer override (toggle enhance/denoise) */
    enhancer?: { type: 'lavasr'; enhance?: boolean; denoise?: boolean }
    /** Per-job output sample rate override */
    outputSampleRate?: number
  }

  export {
    ONNXTTS as default,
    ONNXTTSFiles,
    ONNXTTSOptions,
    ONNXTTSRuntimeConfig,
    EnhancerConfig,
    LavaSREnhancerConfig,
    RuntimeStats,
    SentenceStreamChunkMeta,
    SentenceStreamOptions,
    RunStreamingOptions,
    TextStreamInput,
    TTSOutputChunk,
    TTSRunInput
  }
}

export = ONNXTTS
