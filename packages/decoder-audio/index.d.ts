import QvacLogger = require("@qvac/logging");
import { type QvacResponse } from "@qvac/infer-base";
/** Output sample formats this decoder can resample to. */
export type AudioFormatName = "s16le" | "f32le";
export interface AudioFormatConfig {
    /** FFmpeg sample format id. Null until `load()` resolves it from `ffmpeg.constants`. */
    format: number | null;
    byteLength: number;
}
export interface SupportedAudioFormats {
    s16le: AudioFormatConfig;
    f32le: AudioFormatConfig;
}
export interface FFmpegDecoderConfig {
    /** Index of the stream to decode (default: 0) */
    streamIndex?: number;
    /** Input audio bitrate (default: 192000) */
    inputBitrate?: number;
    /** Output audio format (default: 's16le') */
    audioFormat?: AudioFormatName;
    /** Output sample rate (default: 16000) */
    sampleRate?: number;
}
export interface FFmpegDecoderConstructorParams {
    config?: FFmpegDecoderConfig;
    logger?: QvacLogger.LoggerInterface | null;
    streamIndex?: number;
    inputBitrate?: number;
    audioFormat?: AudioFormatName;
}
export interface DecoderOutput {
    /** Raw interleaved PCM in the configured output format. */
    outputArray: Buffer;
}
export interface RuntimeStats {
    decodeTimeMs: number;
    inputBytes: number;
    outputBytes: number;
    samplesDecoded: number;
    codecName: string | null;
    inputSampleRate: number;
    outputSampleRate: number;
    audioFormat: AudioFormatName;
}
/** Constructor arguments after defaults have been applied. */
interface ResolvedConfig {
    streamIndex: number;
    inputBitrate: number;
    audioFormat: AudioFormatName;
    sampleRate: number;
}
/**
 * FFmpeg-based audio decoder (single-threaded)
 */
declare class FFmpegDecoder {
    SUPPORTED_AUDIO_FORMATS: SupportedAudioFormats;
    OUTPUT_CHANNEL_LAYOUT: number | null;
    config: ResolvedConfig;
    logger: QvacLogger;
    isLoaded: boolean;
    samplesSkipped: number;
    totalSkipSamples: number;
    private _cancelled;
    private readonly _job;
    private _runtimeStats;
    /**
     * Creates an instance of FFmpegDecoder.
     * @param params - Configuration options. Top-level `streamIndex`, `inputBitrate`
     *   and `audioFormat` act as fallbacks for the matching `config` fields.
     */
    constructor({ config, logger, streamIndex, inputBitrate, audioFormat, }?: FFmpegDecoderConstructorParams);
    /**
     * Resets the runtime stats
     */
    private _resetStats;
    /**
     * Get the current runtime stats
     * @returns Current runtime stats
     */
    runtimeStats(): RuntimeStats;
    /**
     * Load and initialize the decoder
     */
    load(): Promise<void>;
    /**
     * Unload the decoder and clean up resources
     */
    unload(): Promise<void>;
    /**
     * Run the decoder on an audio stream
     * @param audioStream - Input audio stream
     * @returns Response with decoded audio
     */
    run(audioStream: AsyncIterable<Buffer>): QvacResponse<DecoderOutput>;
    private _cancelCurrent;
    private _getBufferSize;
    /**
     * Resolves the output constants populated by `load()`. Unreachable before
     * `load()` succeeds, since every caller sits behind the `isLoaded` guard.
     */
    private _resolveOutputFormat;
    private _processFrame;
    private _processPacket;
    private _processFFmpegStream;
    private _collectStreamData;
    private _processStream;
}
export { FFmpegDecoder };
