declare interface BCIConfig {
  smooth_kernel_std?: number;
  smooth_kernel_size?: number;
  sample_rate?: number;
  day_idx?: number;
}

declare interface WhisperConfig {
  language?: string;
  n_threads?: number;
  temperature?: number;
  suppress_nst?: boolean;
  duration_ms?: number;
  translate?: boolean;
  no_timestamps?: boolean;
  single_segment?: boolean;
  [key: string]: unknown;
}

declare interface BCIWhispercppArgs {
  modelPath: string;
  logger?: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

declare interface BCIWhispercppConfig {
  whisperConfig?: WhisperConfig;
  bciConfig?: BCIConfig;
  contextParams?: {
    model?: string;
    use_gpu?: boolean;
    flash_attn?: boolean;
    gpu_device?: number;
  };
  miscConfig?: {
    caption_enabled?: boolean;
  };
}

declare interface TranscriptSegment {
  text: string;
  toAppend: boolean;
  start: number;
  end: number;
  id: number;
}

declare interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  stats: Record<string, number> | null;
}

/**
 * BCI neural signal transcription client powered by whisper.cpp.
 */
declare class BCIWhispercpp {
  constructor(args: BCIWhispercppArgs, config?: BCIWhispercppConfig);

  /** Load and activate the model. */
  load(): Promise<void>;

  /** Transcribe a neural signal binary file. */
  transcribeFile(filePath: string): Promise<TranscriptionResult>;

  /** Transcribe neural signal data (batch). */
  transcribe(neuralData: Uint8Array): Promise<TranscriptionResult>;

  /** Cancel current inference. */
  cancel(): Promise<void>;

  /** Destroy the instance and release resources. */
  destroy(): Promise<void>;
}

/**
 * Compute Word Error Rate between hypothesis and reference strings.
 * @returns WER as a ratio (0.0 = perfect).
 */
declare function computeWER(hypothesis: string, reference: string): number;

declare namespace BCIWhispercpp {
  export {
    BCIWhispercpp as default,
    BCIWhispercpp,
    BCIConfig,
    WhisperConfig,
    BCIWhispercppArgs,
    BCIWhispercppConfig,
    TranscriptSegment,
    TranscriptionResult,
    computeWER,
  };
}

export = BCIWhispercpp;
