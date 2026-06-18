import QvacResponse from '@qvac/infer-base/src/QvacResponse'
import type { LoggerInterface } from '@qvac/logging'
import { Readable } from 'stream'

/**
 * Model type discriminator. The binding auto-detects this from the
 * loaded GGUF's `parakeet.model.type` metadata field; this type is
 * only here for callers that want to surface it in their own UI.
 */
declare type ModelType = 'tdt' | 'ctc' | 'eou' | 'sortformer'

/**
 * Parakeet-specific configuration options. The model type itself is
 * not configured here -- it's auto-detected from the GGUF metadata.
 */
declare interface ParakeetConfig {
  /** Maximum CPU threads for inference (0 lets the engine pick) */
  maxThreads?: number
  /** Enable the linked ggml GPU backend (Metal / Vulkan / CUDA) */
  useGPU?: boolean
  /** Audio sample rate in Hz (default: 16000; engine assumes 16 kHz) */
  sampleRate?: number
  /** Number of audio channels (default: 1, must be mono) */
  channels?: number
  /** Enable caption/subtitle mode (default: false) */
  captionEnabled?: boolean
  /** Include timestamps in output (default: true) */
  timestampsEnabled?: boolean
  /** Random seed for reproducibility (-1 for random, default: -1) */
  seed?: number

  /**
   * Open a long-lived streaming session (StreamSession for ASR,
   * SortformerStreamSession for diarization) at load() time and
   * route each `process()` call through `feed_pcm_f32()`. Speaker
   * IDs stay stable across appends, EOU `<EOU>` boundaries surface
   * as segment markers, and CTC/TDT can opt into energy-VAD events.
   * Default: false (offline `transcribe_samples` / `diarize_samples`).
   *
   * Scope: cross-append streaming state (speaker history, EOU rolling
   * window, partial decode state) is preserved within a single `run()`
   * call -- the JS `append()` layer batches all audio for a job into
   * one `process()` invocation. State does NOT survive across separate
   * `run()` calls on the same model instance; each new `run()` starts
   * a fresh streaming session. For continuous live capture, either
   * drive a single long-running `run()` from a pushable stream, or use
   * the duplex `runStreaming()` API which owns one parakeet streaming
   * session for the lifetime of the call.
   */
  streaming?: boolean
  /** Streaming chunk cadence in milliseconds (default: 2000) */
  streamingChunkMs?: number
  /** Sortformer rolling-history window in ms (default: 30000) */
  streamingHistoryMs?: number
  /** Emit partial segments before chunk boundaries (default: true) */
  streamingEmitPartials?: boolean
  /** CTC/TDT-only energy-VAD events (default: false) */
  streamingEnergyVad?: boolean
  /**
   * ASR encoder left-context window in milliseconds. Audio retained
   * upstream of the current chunk so the encoder has context. Default
   * `parakeet-cpp`'s own (10000 ms). ASR sessions only; Sortformer
   * uses `streamingHistoryMs` instead.
   */
  streamingLeftContextMs?: number
  /**
   * ASR encoder right-lookahead window in milliseconds. Future audio
   * the encoder waits for before emitting each chunk's segments. Adds
   * directly to per-segment latency floor (effective latency >=
   * `chunk_ms + right_lookahead_ms`). Default `parakeet-cpp`'s own
   * (2000 ms). ASR sessions only.
   */
  streamingRightLookaheadMs?: number

  /**
   * AOSC (Audio-Online Speaker Cache): enable v2.1 Sortformer's
   * speaker-cache streaming. Ignored on v1/v2 Sortformer GGUFs and on
   * non-Sortformer models. Set false to force a v2.1 model onto the
   * v1 sliding-window path (e.g. for A/B comparison). Default: true.
   *
   * The cache anchors each speaker to a stable slot across silence and
   * re-entry, fixing the per-chunk permutation-invariance drift that v1
   * suffers from when two voices have been seen in the rolling window.
   * v2.1 is auto-detected from the GGUF metadata tag
   * `parakeet.model_variant == "sortformer-streaming-v2.1-aosc"`.
   */
  streamingSpkCacheEnable?: boolean
  /** AOSC: long-term speaker-cache rows (~15 s of encoder frames). Default: 188. */
  streamingSpkCacheLen?: number
  /** AOSC: FIFO warmup buffer rows. Default: 188. */
  streamingFifoLen?: number
  /** AOSC: encoder left-context window (ms; ~1 encoder frame). Default: 80. */
  streamingChunkLeftContextMs?: number
  /** AOSC: encoder right-context window (ms; ~7 encoder frames). Default: 560. */
  streamingChunkRightContextMs?: number
  /** AOSC: FIFO-overflow pop-out count. Default: 144. */
  streamingSpkCacheUpdatePeriod?: number
  /**
   * Directory the native addon scans for dynamically-loaded ggml
   * backend libraries (`libqvac-speech-ggml-vulkan.so`,
   * `libqvac-speech-ggml-opencl.so`, per-arch
   * `libqvac-speech-ggml-cpu-android_armv*_*.so`). Defaults to the
   * package's own `prebuilds/` folder where cmake-bare installs them
   * next to the `.bare` module on Android / Linux. Pass an explicit
   * path when the host bundles the prebuilds elsewhere (e.g. an
   * Android APK's `nativeLibraryDir`). No-op on Apple targets
   * (statically linked ggml core; no .so backends to discover).
   */
  backendsDir?: string
  /**
   * Persistent directory for ggml-opencl's `clCreateProgramWithBinary`
   * cache. Sets `$GGML_OPENCL_CACHE_DIR` before the first backend
   * init so subsequent process starts skip the cold `clBuildProgram`
   * cost (which dominates first-utterance latency on Adreno).
   * Android-only; ignored on every other platform. Pass the host
   * app's cache directory (e.g. Android `Context.getCacheDir()`).
   */
  openclCacheDir?: string
}

/**
 * Map of model file paths supplied to TranscriptionParakeet.
 */
declare interface TranscriptionParakeetFiles {
  /**
   * Absolute path to a single `.gguf` checkpoint produced by
   * `qvac-parakeet.cpp/scripts/convert-nemo-to-gguf.py`. The same
   * field accepts CTC, TDT, EOU, and Sortformer GGUFs -- the binding
   * picks the right dispatch from the file's metadata.
   */
  model?: string
}

/**
 * Options accepted by the TranscriptionParakeet constructor.
 */
declare interface TranscriptionParakeetArgs {
  files?: TranscriptionParakeetFiles
  config?: TranscriptionParakeetConfig
  logger?: LoggerInterface
  exclusiveRun?: boolean
  [key: string]: unknown
}

/**
 * Configuration for TranscriptionParakeet (non-path settings only).
 */
declare interface TranscriptionParakeetConfig {
  enableStats?: boolean
  parakeetConfig?: ParakeetConfig
  [key: string]: unknown
}

/**
 * Transcription segment returned by the model.
 */
declare interface TranscriptionSegment {
  text: string
  start: number
  end: number
  toAppend: boolean
  id?: number
  /**
   * True when this segment ends on a recognised end-of-utterance
   * boundary. EOU streaming sessions set this on the chunk that
   * contains the `<EOU>` token; CTC / TDT / Sortformer always leave it
   * false. The `text` field still carries any speech tokens decoded in
   * the same chunk, so consumers that want a turn-end signal
   * independent of the transcript should test this flag rather than
   * the segment text.
   */
  isEndOfTurn?: boolean
  /**
   * True when this segment's first token is a SentencePiece word-start
   * (the piece begins with the `▁` U+2581 marker), false when it is a
   * wordpiece continuation of the previous segment's last token.
   *
   * Streaming consumers building a running transcript should insert a
   * separator (e.g. " ") between successive segments only when the
   * *new* segment has `startsWord === true`. Concatenating verbatim
   * when `startsWord === false` rejoins chunk-boundary splits like
   * `["pun", "ctuation"]` into `"punctuation"`; inserting a space
   * there would yield `"pun ctuation"` instead.
   *
   * Always true on the very first segment of a session and on
   * Sortformer (diarization) segments; field absent on offline
   * transcribe results.
   */
  startsWord?: boolean
}

/**
 * Output callback events.
 */
declare type OutputEvent = 'JobStarted' | 'Output' | 'JobEnded' | 'Error'

/**
 * Input types accepted by the Parakeet addon.
 */
declare type AppendInput =
  | { type: 'audio'; data: ArrayBuffer; priority?: number }
  | { type: 'end of job' }

/**
 * Per-call overrides for the duplex streaming session opened by
 * `TranscriptionParakeet.runStreaming()`. Any field omitted falls back
 * to the corresponding `ParakeetConfig.streaming*` value used at load
 * time.
 */
declare interface StreamingRunConfig {
  /** Encoder cadence in ms (overrides `streamingChunkMs`). */
  chunkMs?: number
  /** Sortformer rolling-history window in ms (overrides `streamingHistoryMs`). */
  historyMs?: number
  /** ASR encoder left-context window in ms (overrides `streamingLeftContextMs`). */
  leftContextMs?: number
  /** ASR encoder right-lookahead window in ms (overrides `streamingRightLookaheadMs`). */
  rightLookaheadMs?: number
  /** Emit partial segments before chunk boundaries. */
  emitPartials?: boolean
  /** CTC/TDT-only energy-VAD events. */
  emitEnergyVad?: boolean
  /** AOSC: enable/disable v2.1 speaker cache (overrides `streamingSpkCacheEnable`). */
  spkCacheEnable?: boolean
  /** AOSC: long-term speaker-cache rows (overrides `streamingSpkCacheLen`). */
  spkCacheLen?: number
  /** AOSC: FIFO warmup buffer rows (overrides `streamingFifoLen`). */
  fifoLen?: number
  /** AOSC: encoder left-context window in ms (overrides `streamingChunkLeftContextMs`). */
  chunkLeftContextMs?: number
  /** AOSC: encoder right-context window in ms (overrides `streamingChunkRightContextMs`). */
  chunkRightContextMs?: number
  /** AOSC: FIFO-overflow pop-out count (overrides `streamingSpkCacheUpdatePeriod`). */
  spkCacheUpdatePeriod?: number
}

/**
 * Minimal interface for the native addon.
 */
declare interface Addon {
  activate(): Promise<void>
  /** Returns the JS-owned job ID for the buffered or running transcription. */
  append(input: AppendInput): Promise<number>
  /** Cancels the matching JS-owned job when one is active or buffered. */
  cancel(jobId?: number): Promise<void>
  loadWeights(weightsData: { filename: string; chunk: Uint8Array; completed: boolean }): Promise<void>
  status(): Promise<string>
  pause(): Promise<void>
  stop(): Promise<void>
  reload(config: ParakeetConfig): Promise<void>
  destroyInstance(): Promise<void>

  /**
   * Open a long-lived duplex streaming session. Fed via
   * `appendStreamingAudio()`; closed via `endStreaming()` (graceful)
   * or `cancel()` (forceful). Per-segment Transcripts surface through
   * the regular output callback as soon as the engine emits each chunk.
   */
  startStreaming(config?: StreamingRunConfig): Promise<number>
  /** Push an audio chunk into the active streaming session. */
  appendStreamingAudio(data: Float32Array | Int16Array | ArrayBuffer | ArrayBufferView): Promise<boolean>
  /** Gracefully close the active streaming session. */
  endStreaming(): Promise<void>
  /** Forcefully abort the active streaming session. */
  cancelStreaming(): Promise<void>
}

declare interface InferenceClientState {
  configLoaded: boolean
  weightsLoaded: boolean
  destroyed: boolean
}

/**
 * High-level Parakeet speech-to-text client backed by the ggml engine
 * sourced from qvac-parakeet.cpp. Accepts a single `.gguf` checkpoint
 * (CTC / TDT / EOU / Sortformer) -- the binding auto-detects the
 * model type from GGUF metadata.
 */
declare class TranscriptionParakeet {
  protected readonly _config: TranscriptionParakeetConfig
  protected addon: Addon
  protected params: ParakeetConfig

  constructor(opts: TranscriptionParakeetArgs)

  validateModelFiles(): void
  protected _load(): Promise<void>
  load(): Promise<void>

  /**
   * Run inference on an audio stream. When `opts.stats` was set on
   * construction, `response.stats` matches {@link TranscriptionParakeet.RuntimeStats}.
   */
  run(
    audioStream: Readable
  ): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>>

  /**
   * Duplex streaming entry point: opens a long-lived
   * `parakeet::StreamSession` (or `SortformerStreamSession`) on the
   * native side and feeds chunks from `audioStream` directly into it
   * as they arrive. Per-chunk segments surface through
   * `response.onUpdate(...)` as soon as the engine emits them; the
   * response resolves when the audio stream completes. Configure the
   * model with `parakeetConfig.streaming = true` (default chunk
   * cadence, history, etc. read from the `streaming*` fields) and
   * optionally override per-call via `streamingConfig`.
   */
  runStreaming(
    audioStream: Readable,
    streamingConfig?: StreamingRunConfig
  ): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>>

  reload(newConfig?: { parakeetConfig?: Partial<ParakeetConfig> }): Promise<void>
  unload(): Promise<void>
  getState(): InferenceClientState
  cancel(): Promise<void>
  status(): Promise<string | undefined>
  pause(): Promise<void>
  unpause(): Promise<void>
  destroy(): Promise<void>
}

declare namespace TranscriptionParakeet {
  /**
   * Numeric code identifying which compute backend the engine is running
   * on. Captured once at `loadModel()` from `Engine::backend_name()`
   * (qvac-parakeet.cpp). Stable for the lifetime of the model.
   *
   *   0 = CPU       (no GPU compiled in, useGPU=false, or GPU init refused)
   *   1 = Metal     (macOS / iOS)
   *   2 = CUDA      (NVIDIA)
   *   3 = Vulkan    (cross-platform GPU; enabled on Linux / Windows / Android via parakeet-cpp[vulkan])
   *   4 = OpenCL    (Adreno on Android)
   *  99 = other     (a future / unrecognised backend)
   */
  export enum BackendId {
    CPU = 0,
    Metal = 1,
    CUDA = 2,
    Vulkan = 3,
    OpenCL = 4,
    Other = 99
  }

  /**
   * Keys returned by the native addon `ParakeetModel::runtimeStats()`
   * when stats are enabled. `totalTime` and `totalWallMs` are wall
   * time in milliseconds; `audioDurationMs` and other `*Ms` fields
   * are milliseconds where applicable. `decoderMs`, `melSpecMs`,
   * `totalEncodedFrames`, and `totalTokens` are populated only by
   * the offline ASR path and stay 0 for streaming / Sortformer.
   *
   * `backendDevice` and `backendId` are the post-fallback truth: a
   * load-time GPU init failure (e.g. Adreno-tier rejection, missing
   * OpenCL ICD, simulator without Metal) leaves both at 0 / `CPU`
   * even when `useGPU: true` was requested. See {@link BackendId}
   * for the integer codes.
   */
  export interface RuntimeStats {
    totalTime: number
    audioDurationMs: number
    totalSamples: number
    totalTokens: number
    totalTranscriptions: number
    processCalls: number
    modelLoadMs: number
    melSpecMs: number
    encoderMs: number
    decoderMs: number
    totalWallMs: number
    totalEncodedFrames: number
    /** 0 = CPU, 1 = GPU (post-fallback). */
    backendDevice: number
    /** {@link BackendId} integer code. */
    backendId: number
    /**
     * 1 when a GPU was present but the engine routed to CPU because the GPU
     * mis-computes the models (e.g. Mali Vulkan) or the vendor/tier is declined
     * by policy; 0 otherwise. A CPU `backendDevice` with `gpuUnsupported === 1`
     * is expected, not a regression.
     */
    gpuUnsupported: number
  }

  /**
   * Payload passed to `onUpdate` (array of segments or a single segment).
   */
  export type ParakeetRunOutput = TranscriptionSegment[] | TranscriptionSegment

  export {
    TranscriptionParakeet as default,
    TranscriptionParakeet,
    ModelType,
    ParakeetConfig,
    TranscriptionParakeetFiles,
    TranscriptionParakeetArgs,
    TranscriptionParakeetConfig,
    TranscriptionSegment,
    OutputEvent,
    AppendInput,
    Addon,
    BackendId,
    InferenceClientState,
    StreamingRunConfig
  }
}

export = TranscriptionParakeet
