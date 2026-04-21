declare interface BCIConfig {
  /**
   * Index into the day-specific projection matrices in bci-embedder.bin.
   * Must match the recording day the neural signal was captured on.
   * Defaults to 0.
   */
  day_idx?: number;
}

declare interface WhisperConfig {
  language?: string;
  n_threads?: number;
  temperature?: number;
  suppress_nst?: boolean;
  suppress_blank?: boolean;
  duration_ms?: number;
  translate?: boolean;
  no_timestamps?: boolean;
  single_segment?: boolean;
  print_special?: boolean;
  print_progress?: boolean;
  print_realtime?: boolean;
  print_timestamps?: boolean;
  detect_language?: boolean;
  greedy_best_of?: number;
  beam_search_beam_size?: number;
}

declare interface BCIWhispercppFiles {
  model: string;
}

declare interface BCIWhispercppArgs {
  files: BCIWhispercppFiles;
  logger?: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  opts?: {
    stats?: boolean;
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

declare interface QvacResponse {
  output: unknown[];
  stats: Record<string, number>;
  onUpdate(callback: (data: unknown) => void): QvacResponse;
  onFinish(callback: (result: unknown) => void): QvacResponse;
  onError(callback: (error: Error) => void): QvacResponse;
  onCancel(callback: () => void): QvacResponse;
  await(): Promise<unknown[]>;
  cancel(): Promise<void>;
  iterate(): AsyncGenerator<unknown>;
  getLatest(): unknown;
}

/**
 * BCI neural signal transcription client powered by whisper.cpp.
 * Uses createJobHandler + exclusiveRunQueue from @qvac/infer-base.
 */
declare class BCIWhispercpp {
  constructor(args: BCIWhispercppArgs, config?: BCIWhispercppConfig);

  /** Load and activate the model. */
  load(): Promise<void>;

  /** Transcribe a neural signal binary file (convenience wrapper). */
  transcribeFile(filePath: string): Promise<QvacResponse>;

  /** Transcribe neural signal data (batch). Returns QvacResponse. */
  transcribe(neuralData: Uint8Array): Promise<QvacResponse>;

  /** Transcribe a stream of neural signal chunks. Returns QvacResponse. */
  transcribeStream(
    signalStream: AsyncIterable<Uint8Array>
  ): Promise<QvacResponse>;

  /** Cancel current inference. */
  cancel(): Promise<void>;

  /** Unload the model and release native resources. */
  unload(): Promise<void>;

  /** Destroy the instance, unload, and mark as permanently destroyed. */
  destroy(): Promise<void>;

  /** Get current state (configLoaded, destroyed). */
  getState(): { configLoaded: boolean; destroyed: boolean };
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
    BCIWhispercppFiles,
    BCIWhispercppArgs,
    BCIWhispercppConfig,
    TranscriptSegment,
    QvacResponse,
    computeWER,
  };
}

export = BCIWhispercpp;
