import type QvacResponse from '@qvac/infer-base/src/QvacResponse'

/**
 * Model file paths for the GGML Chatterbox backend.  Either provide both
 * `t3Model` + `s3genModel` directly, or a single `modelDir` that contains
 * `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` side-by-side (the
 * layout produced by `scripts/ensure-chatterbox.js`).  All paths must be
 * absolute (passed through to the native layer as-is).
 */
declare interface TTSGgmlFiles {
  /** Bundle root containing both `chatterbox-t3-turbo.gguf` and `chatterbox-s3gen.gguf`. */
  modelDir?: string
  /** T3 (text → speech tokens) GGUF path. Overrides `modelDir` when both are set. */
  t3Model?: string
  t3ModelPath?: string
  t3?: string
  /** S3Gen + HiFT (speech tokens → 24 kHz wav) GGUF path. Overrides `modelDir` when both are set. */
  s3genModel?: string
  s3genModelPath?: string
  s3gen?: string
  /** Optional directory containing baked voice profiles (`--save-voice` output from the CLI). */
  voicesDir?: string
}

declare interface TTSGgmlRuntimeConfig {
  /** Language code — default "en". Only English is supported by the current Chatterbox GGUF. */
  language?: string
  /** Route inference through a GPU backend (Metal / Vulkan / CUDA) if available. */
  useGPU?: boolean
  /** Resample the 24 kHz native output to this rate before emitting (8000–192000 Hz). */
  outputSampleRate?: number
}

declare interface TTSGgmlOptions {
  files?: TTSGgmlFiles
  config?: TTSGgmlRuntimeConfig
  logger?: object
  lazySessionLoading?: boolean
  /** Voice-cloning reference audio path (wav).  See `qvac-tts.cpp --reference-audio`. */
  referenceAudio?: string
  /** Directory of baked voice-conditioning tensors (`qvac-tts.cpp --ref-dir`). */
  voiceDir?: string
  /** RNG seed for the CFM initial noise + SineGen excitation (same text, different take). */
  seed?: number
  /** Move N layers to the GPU backend.  Pass 99 (or any large number) to move everything. */
  nGpuLayers?: number
  /** Override `std::thread::hardware_concurrency()`. */
  threads?: number
  /** Streaming: speech tokens per chunk (25 ≈ 1 s of audio).  0 disables streaming. */
  streamChunkTokens?: number
  /** Streaming: override size of the first chunk so first-audio-out lands early. */
  streamFirstChunkTokens?: number
  /** Streaming: CFM Euler step count (1 halves CFM cost at small quality penalty, 2 matches Python meanflow). */
  cfmSteps?: number
  opts?: object
  exclusiveRun?: boolean
}

/**
 * GGML-backed Chatterbox TTS (via @qvac/tts-cpp / qvac-tts.cpp).  API-compatible
 * with the Chatterbox engine exposed by @qvac/tts-onnx — `run`, `runStream`,
 * `runStreaming`, `reload`, `unload`, `destroy` — so downstream consumers can
 * swap backends without touching their orchestration code.
 */
declare class TTSGgml {
  constructor(options?: TTSGgmlOptions)

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
