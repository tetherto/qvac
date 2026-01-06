declare module "@qvac/transcription-whispercpp" {
  import type { Readable } from "stream";

  export interface VadParams {
    threshold?: number;
    min_speech_duration_ms?: number;
    min_silence_duration_ms?: number;
    max_speech_duration_s?: number;
    speech_pad_ms?: number;
    samples_overlap?: number;
  }

  export interface WhisperConfig {
    audio_format?: string;
    language?: string;
    vad_model_path?: string;
    vad_params?: VadParams;
    [key: string]: unknown;
  }

  export interface TranscriptionArgs {
    loader: unknown;
    logger?: unknown;
    modelName: string;
    vadModelName?: string;
    diskPath?: string;
    exclusiveRun?: boolean;
    [args: string]: unknown;
  }

  export interface TranscriptionConfig {
    path?: string;
    enableStats?: boolean;
    vadModelPath?: string;
    whisperConfig: WhisperConfig | Record<string, unknown>;
    [args: string]: unknown;
  }

  export interface TranscriptionResult {
    text: string;
  }

  export interface TranscriptionResponse {
    iterate(): AsyncIterableIterator<TranscriptionResult[]>;
  }

  export default class TranscriptionWhispercpp {
    constructor(args: TranscriptionArgs, config: TranscriptionConfig);

    run(audioStream: Readable): Promise<TranscriptionResponse>;

    reload(newConfig?: {
      whisperConfig?: Partial<WhisperConfig>;
      miscConfig?: { caption_enabled?: boolean };
      audio_format?: string;
    }): Promise<void>;
  }
}

declare module "@qvac/transcription-whispercpp/addonLogging" {
  interface AddonLogging {
    setLogger(callback: (priority: number, message: string) => void): void;
    releaseLogger(): void;
  }
  const addonLogging: AddonLogging;
  export default addonLogging;
}
