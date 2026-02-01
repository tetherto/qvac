declare module "@qvac/decoder-audio" {
  import type { Readable } from "stream";

  export interface FFmpegDecoderOptions {
    config?: {
      audioFormat?: "s16le" | "f32le";
      sampleRate?: number;
      streamIndex?: number;
      inputBitrate?: number;
    };
    logger?: unknown;
    streamIndex?: number;
    inputBitrate?: number;
    audioFormat?: "s16le" | "f32le";
  }

  export interface DecoderOutput {
    outputArray: ArrayBuffer;
  }

  export interface DecoderResponse {
    onUpdate(callback: (output: DecoderOutput) => void): DecoderResponse;
    onFinish(callback: () => void | Promise<void>): DecoderResponse;
    onError(callback: (errorMessage: string) => void): DecoderResponse;
    await(): Promise<void>;
  }

  export class FFmpegDecoder {
    constructor(options: FFmpegDecoderOptions);

    load(): Promise<void>;
    run(inputStream: Readable): Promise<DecoderResponse>;
    unload(): Promise<void>;
    pause(): Promise<void>;
    unpause(): Promise<void>;
    stop(): Promise<void>;
    status(): { loaded: boolean; active: boolean; paused: boolean };
  }
}

declare module "@qvac/decoder-audio/constants" {
  /**
   * Audio formats that require decoding before processing
   */
  export const FORMATS_NEEDING_DECODE: readonly string[];

  /**
   * All supported audio formats (including raw)
   */
  export const SUPPORTED_AUDIO_FORMATS: readonly string[];
}
