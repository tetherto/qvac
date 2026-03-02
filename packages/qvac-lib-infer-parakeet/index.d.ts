/// <reference types="node" />

import BaseInference from '@qvac/infer-base/WeightsProvider/BaseInference';
import WeightsProvider from '@qvac/infer-base/WeightsProvider/WeightsProvider';
import type { QvacResponse } from '@qvac/infer-base';
import type { LoggerInterface } from '@qvac/logging';

/**
 * Model type options for Parakeet
 */
export type ModelType = 'tdt' | 'ctc' | 'eou' | 'sortformer';

/**
 * Parakeet-specific configuration options
 */
export interface ParakeetConfig {
  /** Model type: 'tdt' (multilingual), 'ctc' (English), 'eou' (streaming), 'sortformer' (diarization) */
  modelType?: ModelType;
  /** Maximum CPU threads for inference */
  maxThreads?: number;
  /** Enable GPU acceleration (CUDA/CoreML/DirectML) */
  useGPU?: boolean;
  /** Audio sample rate in Hz (default: 16000) */
  sampleRate?: number;
  /** Number of audio channels (default: 1, must be mono) */
  channels?: number;
  /** Enable caption/subtitle mode (default: false) */
  captionEnabled?: boolean;
  /** Include timestamps in output (default: true) */
  timestampsEnabled?: boolean;
  /** Random seed for reproducibility (-1 for random, default: -1) */
  seed?: number;
}

/**
 * Arguments required to construct an instance of TranscriptionParakeet
 */
export interface TranscriptionParakeetArgs {
  /** External loader instance (e.g. FilesystemDL, HyperdriveDL) */
  loader: unknown;
  /** Optional structured logger */
  logger?: LoggerInterface;
  /** Name of the model directory */
  modelName: string;
  /** Disk directory where model files are stored */
  diskPath?: string;
  /** Whether to run exclusively (default: true) */
  exclusiveRun?: boolean;
  /** Additional arguments */
  [key: string]: unknown;
}

/**
 * Configuration for TranscriptionParakeet
 */
export interface TranscriptionParakeetConfig {
  /** Direct path to model directory (alternative to diskPath + modelName) */
  path?: string;
  /** Absolute path to encoder ONNX graph file (encoder-model.onnx) */
  encoderPath?: string;
  /** Absolute path to encoder ONNX weights file (encoder-model.onnx.data) */
  encoderDataPath?: string;
  /** Absolute path to decoder-joint ONNX file (decoder_joint-model.onnx) */
  decoderPath?: string;
  /** Absolute path to vocabulary file (vocab.txt) */
  vocabPath?: string;
  /** Absolute path to preprocessor ONNX file (preprocessor.onnx / nemo128.onnx) */
  preprocessorPath?: string;
  /** Enable statistics collection */
  enableStats?: boolean;
  /** Parakeet-specific configuration */
  parakeetConfig: ParakeetConfig;
  /** Additional configuration */
  [key: string]: unknown;
}

/**
 * Progress data reported during weight download
 */
export interface ProgressData {
  action: string;
  totalSize: number;
  totalFiles: number;
  filesProcessed: number;
  currentFile: string;
  currentFileProgress: string;
  overallProgress: string;
}

/**
 * Transcription segment returned by the model
 */
export interface TranscriptionSegment {
  /** Transcribed text */
  text: string;
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Whether to append to previous output */
  toAppend: boolean;
  /** Segment ID */
  id?: number;
}

/**
 * Output callback events
 */
export type OutputEvent = 'JobStarted' | 'Output' | 'JobEnded' | 'Error';

/**
 * Callback invoked with progress data during downloads
 */
export type ReportProgressCallback = (progressData: ProgressData) => void;

/**
 * Input types accepted by the Parakeet addon
 */
export type AppendInput =
  | { type: 'audio'; data: ArrayBuffer; priority?: number }
  | { type: 'end of job' };

/**
 * Minimal interface for the native addon
 */
export interface Addon {
  activate(): Promise<void>;
  append(input: AppendInput): Promise<number>;
  cancel(jobId?: number): Promise<void>;
  loadWeights(weightsData: { filename: string; chunk: Uint8Array; completed: boolean }): Promise<void>;
  status(): Promise<string>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  reload(config: ParakeetConfig): Promise<void>;
  destroyInstance(): Promise<void>;
}

/**
 * ONNX Runtime client implementation for the Parakeet speech-to-text model.
 * Supports NVIDIA Parakeet ASR models in ONNX format.
 */
declare class TranscriptionParakeet extends BaseInference {
  protected readonly _config: TranscriptionParakeetConfig;
  protected readonly _diskPath: string;
  protected readonly _modelName: string;
  protected addon!: Addon;
  protected weightsProvider: WeightsProvider;
  protected params: ParakeetConfig;

  /**
   * Creates an instance of TranscriptionParakeet.
   * @param args - arguments for inference setup
   * @param config - environment-specific inference setup configuration
   */
  constructor(
    args: TranscriptionParakeetArgs,
    config: TranscriptionParakeetConfig
  );

  /**
   * Validate that required model files exist
   */
  validateModelFiles(): void;

  /**
   * Load model, weights, and activate addon.
   * @param closeLoader - Close loader when done.
   * @param reportProgressCallback - Hook for progress updates.
   */
  protected _load(
    closeLoader?: boolean,
    reportProgressCallback?: ReportProgressCallback
  ): Promise<void>;

  /**
   * Load model, weights, and activate addon (public API).
   * @param closeLoader - Close loader when done.
   * @param reportProgressCallback - Hook for progress updates.
   */
  load(
    closeLoader?: boolean,
    reportProgressCallback?: ReportProgressCallback
  ): Promise<void>;

  /**
   * Run transcription on an audio stream.
   * @param audioStream - Stream of audio data (16kHz mono)
   * @returns A QvacResponse representing the transcription job
   */
  run(audioStream: AsyncIterable<Buffer>): Promise<QvacResponse>;

  /**
   * Reload the model with new configuration parameters.
   * @param newConfig - New configuration parameters
   */
  reload(newConfig?: {
    parakeetConfig?: Partial<ParakeetConfig>;
  }): Promise<void>;

  /**
   * Download model weights from loader.
   * @param reportProgressCallback - Progress callback
   * @param opts - Options
   */
  downloadWeights(
    reportProgressCallback?: ReportProgressCallback,
    opts?: { closeLoader?: boolean }
  ): Promise<void>;

  /**
   * Unload the model and free resources.
   */
  unload(): Promise<void>;
}

declare namespace TranscriptionParakeet {
  export {
    TranscriptionParakeet as default,
    TranscriptionParakeet,
    ModelType,
    ParakeetConfig,
    TranscriptionParakeetArgs,
    TranscriptionParakeetConfig,
    ProgressData,
    TranscriptionSegment,
    OutputEvent,
    ReportProgressCallback,
    AppendInput,
    Addon
  };
}

export = TranscriptionParakeet;

