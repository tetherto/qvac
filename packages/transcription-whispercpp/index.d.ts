import QvacResponse from "@qvac/infer-base/src/QvacResponse";
import type { LoggerInterface } from "@qvac/logging";
import { Readable } from "stream";

declare interface VadParams {
  threshold?: number;
  min_speech_duration_ms?: number;
  min_silence_duration_ms?: number;
  max_speech_duration_s?: number;
  speech_pad_ms?: number;
  samples_overlap?: number;
}

declare interface WhisperConfig {
  audio_format?: string;
  language?: string;
  vad_model_path?: string;
  vad_params?: VadParams;
  /**
   * Root directory for dynamically-loaded ggml backend `.so` files
   * (Vulkan, OpenCL, per-arch CPU variants on Android). Defaults to the
   * package's `prebuilds/` folder; the native addon appends
   * `<bare-target>/<module-name>` before scanning. Pass an explicit path
   * when prebuilds live elsewhere — e.g. Android
   * `ApplicationInfo.nativeLibraryDir` when backend libs ship inside the
   * APK. No-op on Apple (statically linked).
   */
  backendsDir?: string;
  [key: string]: unknown;
}

declare interface TranscriptionWhispercppFiles {
  model: string;
  vadModel?: string;
}

declare interface TranscriptionWhispercppArgs {
  files: TranscriptionWhispercppFiles;
  logger?: LoggerInterface;
  exclusiveRun?: boolean;
  opts?: { stats?: boolean };
  [args: string]: unknown;
}

declare interface TranscriptionWhispercppConfig {
  path?: string;
  enableStats?: boolean;
  vadModelPath?: string;
  whisperConfig: WhisperConfig;
  [args: string]: unknown;
}

declare interface InferenceClientState {
  configLoaded: boolean;
  weightsLoaded: boolean;
  destroyed: boolean;
}

/**
 * A single transcription segment emitted by the Whisper addon in an output update.
 */
declare interface WhisperTranscriptionSegment {
  text: string
  [key: string]: unknown
}

declare interface WhisperStreamingOptions {
  emitVadEvents?: boolean;
  conversationMode?: boolean;
  endOfTurnSilenceMs?: number;
  vadRunIntervalMs?: number;
}

declare interface VadStateEvent {
  type: "vad";
  speaking: boolean;
  probability: number;
}

declare interface EndOfTurnEvent {
  type: "endOfTurn";
  silenceDurationMs: number;
}

/**
 * GGML client implementation for the Whisper transcription model
 */
declare class TranscriptionWhispercpp {
  /**
   * Creates an instance of WhisperClient.
   * @constructor
   * @param {TranscriptionWhispercppArgs} args arguments for inference setup
   * @param {TranscriptionWhispercppConfig} config - environment-specific inference setup configuration
   */
  constructor(
    args: TranscriptionWhispercppArgs,
    config: TranscriptionWhispercppConfig
  );

  getState(): InferenceClientState;

  load(...args: unknown[]): Promise<void>;

  unload(): Promise<void>;

  destroy(): Promise<void>;

  pause(): Promise<void>;

  unpause(): Promise<void>;

  stop(): Promise<void>;

  status(): Promise<string>;

  cancel(): Promise<void>;

  /**
   * Reload the model with new configuration parameters.
   * Useful for changing settings like language without destroying the instance.
   * @param {Object} newConfig - New configuration parameters
   * @returns {Promise<void>} - A promise that resolves when the model is reloaded and activated.
   */
  reload(newConfig?: {
    whisperConfig?: Partial<WhisperConfig>;
    miscConfig?: { caption_enabled?: boolean };
    audio_format?: string;
  }): Promise<void>;

  /**
   * Run transcription on an audio stream. When `opts.stats` was set on construction, `response.stats` matches {@link TranscriptionWhispercpp.RuntimeStats}.
   */
  run(
    audioStream: Readable
  ): Promise<QvacResponse<TranscriptionWhispercpp.WhisperRunOutput>>;

  runStreaming(
    audioStream: Readable,
    opts?: WhisperStreamingOptions
  ): Promise<QvacResponse<TranscriptionWhispercpp.WhisperRunOutput>>;
}

declare namespace TranscriptionWhispercpp {
  /**
   * Keys returned by the native addon `WhisperModel::runtimeStats()` when stats are enabled.
   * `totalTime` is wall time in seconds; `audioDurationMs` and whisper-prefixed fields are milliseconds where applicable.
   */
  export interface RuntimeStats {
    totalTime: number
    realTimeFactor: number
    tokensPerSecond: number
    audioDurationMs: number
    totalSamples: number
    totalTokens: number
    totalSegments: number
    processCalls: number
    whisperSampleMs: number
    whisperEncodeMs: number
    whisperDecodeMs: number
    whisperBatchdMs: number
    whisperPromptMs: number
    totalWallMs: number
    /**
     * Post-fallback device class of the backend whisper actually
     * initialised against. `0` = CPU, `1` = GPU. Captured once per
     * `load()` by `WhisperModel::captureActiveBackendInfo()` — does
     * not change across `run()` calls on the same instance.
     *
     * A `use_gpu: true` request that fell back to CPU at load time
     * surfaces here as `0` and emits a WARNING through the addon
     * logger. Mirrors `transcription-parakeet`'s `backendDevice`.
     */
    backendDevice: number
    /**
     * Numeric identifier of the specific GPU backend ggml picked at
     * load time, see {@link BackendId} for the integer codes. `0` when
     * `backendDevice` is `0`. Kept in lock-step with
     * `transcription-parakeet`'s `BackendId` enum so the same integer
     * means the same backend across both speech-stack addons.
     */
    backendId: number
    /**
     * Total memory of the active GPU device in MiB at model load time,
     * or `-1` if the backend does not expose memory accounting (e.g.
     * some Vulkan ICDs on Apple silicon). Snapshot only — not a live
     * counter. Whisper-specific extra; `transcription-parakeet` does
     * not expose this.
     */
    gpuMemTotalMb: number
    /**
     * Free memory of the active GPU device in MiB at model load time,
     * or `-1` if the backend does not expose memory accounting.
     * Whisper-specific extra.
     */
    gpuMemFreeMb: number
  }

  /**
   * Numeric code identifying which compute backend whisper.cpp picked
   * at `load()` time. Captured once by
   * `WhisperModel::captureActiveBackendInfo()` from the ggml backend
   * registry and stable for the lifetime of the model.
   *
   * Numbering is the same as `transcription-parakeet`'s `BackendId`
   * (CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, Other=99) so a
   * device-farm or runtime-stats dashboard can compare the two speech
   * addons by the same integer.
   *
   *   0 = CPU       (use_gpu=false, GPU init refused, or no GPU compiled in)
   *   1 = Metal     (macOS / iOS)
   *   2 = CUDA      (NVIDIA)
   *   3 = Vulkan    (cross-platform GPU; enabled on Linux / Windows / Android via whisper-cpp[vulkan])
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
   * Payload passed to `onUpdate` for transcription output (array of segments or a single segment object).
   */
  export type WhisperRunOutput =
    | WhisperTranscriptionSegment[]
    | WhisperTranscriptionSegment
    | VadStateEvent
    | EndOfTurnEvent

  export {
    TranscriptionWhispercpp as default,
    TranscriptionWhispercpp,
    BackendId,
    VadParams,
    WhisperConfig,
    TranscriptionWhispercppArgs,
    TranscriptionWhispercppFiles,
    TranscriptionWhispercppConfig,
    WhisperTranscriptionSegment,
    WhisperStreamingOptions,
    VadStateEvent,
    EndOfTurnEvent,
    InferenceClientState,
  };
}

export = TranscriptionWhispercpp;
