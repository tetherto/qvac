import BaseInference, { Loader, QvacResponse } from "@qvac/infer-base";
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
  [key: string]: unknown;
}

declare interface TranscriptionWhispercppArgs {
  loader: Loader;
  logger?: LoggerInterface;
  modelName: string;
  vadModelName?: string;
  diskPath?: string;
  [args: string]: unknown;
}

declare interface ProgressData {
  action: string;
  totalSize: number;
  totalFiles: number;
  filesProcessed: number;
  currentFile: string;
  currentFileProgress: string;
  overallProgress: string;
}

declare interface TranscriptionWhispercppConfig {
  path?: string;
  enableStats?: boolean;
  vadModelPath?: string;
  whisperConfig: WhisperConfig;
  [args: string]: unknown;
}

declare type ReportProgressCallback = (progressData: ProgressData) => void;

/**
 * A single transcription segment emitted by the Whisper addon in an output update.
 */
declare interface WhisperTranscriptionSegment {
  text: string
  [key: string]: unknown
}

/**
 * GGML client implementation for the Whisper transcription model
 */
declare class TranscriptionWhispercpp extends BaseInference {
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

  /**
   * Load model, weights, and activate addon.
   * @param {boolean} [closeLoader=false] - Close loader when done.
   * @param {ReportProgressCallback} [reportProgressCallback] - Hook for progress updates.
   * @returns {Promise<void>} - A promise that resolves when the model is fully loaded.
   */
  _load(
    closeLoader?: boolean,
    reportProgressCallback?: ReportProgressCallback
  ): Promise<void>;

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
  }

  /**
   * Payload passed to `onUpdate` for transcription output (array of segments or a single segment object).
   */
  export type WhisperRunOutput =
    | WhisperTranscriptionSegment[]
    | WhisperTranscriptionSegment

  export {
    TranscriptionWhispercpp as default,
    TranscriptionWhispercpp,
    VadParams,
    WhisperConfig,
    TranscriptionWhispercppArgs,
    TranscriptionWhispercppConfig,
    ProgressData,
    ReportProgressCallback,
    WhisperTranscriptionSegment,
  };
}

export = TranscriptionWhispercpp;
