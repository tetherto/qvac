import { Readable } from "stream";
import { QvacResponse, Loader } from "@qvac/infer-base";
import type { WhisperConfig } from ".";

declare interface FFmpegDecoderConfig {
    streamIndex?: number;
    inputBitrate?: number;
}

declare interface TranscriptionFfmpegAddonArgs {
    loader: Loader;
    params?: {
        decoder?: FFmpegDecoderConfig;
        [key: string]: unknown;
    };
    logger?: any;
    modelName?: string;
    vadModelName?: string;
    diskPath?: string;
    [key: string]: unknown;
}

declare interface TranscriptionFfmpegAddonConfig {
    path?: string;
    opts?: {
        stats?: boolean;
        [key: string]: unknown;
    };
    whisperConfig?: WhisperConfig;
    [key: string]: unknown;
}

/**
 * TranscriptionFfmpegAddon with FFmpeg decoder support
 *
 * Provides a complete transcription pipeline that:
 * - Decodes various audio formats (WAV, MP3, M4A, OGG, Opus, FLAC, etc.)
 * - Resamples to 16kHz mono
 * - Transcribes using Whisper model
 */
declare class TranscriptionFfmpegAddon {
    /**
     * Creates an instance of TranscriptionFfmpegAddon
     * @param args - Configuration arguments including loader, model paths, and decoder config
     * @param config - Whisper configuration including VAD settings
     */
    constructor(args: TranscriptionFfmpegAddonArgs, config?: TranscriptionFfmpegAddonConfig);

    /**
     * Load model, decoder, and activate addon
     * @param closeLoader - Whether to close the loader after loading
     * @param reportProgress - Callback function to report loading progress
     */
    load(
        closeLoader?: boolean,
        reportProgress?: (data: any) => void
    ): Promise<void>;

    /**
     * Unload and clean up resources
     */
    unload(): Promise<void>;

    /**
     * Run transcription on an audio stream
     * @param audioStream - Audio stream in any format supported by FFmpeg
     * @returns Promise that resolves to a QvacResponse with transcription results
     */
    run(audioStream: Readable): Promise<QvacResponse>;

    /**
     * Download model files
     * @param progressReport - Optional progress report instance
     */
    download(progressReport?: any): Promise<any>;

    /**
     * Delete local model files
     */
    delete(): Promise<any>;

    /**
     * Pause inference
     */
    pause(): void;

    /**
     * Resume inference
     */
    resume(): void;

    /**
     * Destroy and clean up all resources
     */
    destroy(): Promise<void>;
}

export = TranscriptionFfmpegAddon;
