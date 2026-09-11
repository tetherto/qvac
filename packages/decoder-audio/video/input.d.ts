import ffmpeg = require("bare-ffmpeg");
import type { VideoInput, VideoReader } from "./types";
/** Chunk streams are finite files, not live sessions. Temp paths never escape this owner. */
export declare function prepareVideoInput(input: VideoInput, maxBytes: number, tempDirectory?: string, signal?: AbortSignal): Promise<{
    size: number;
    read(offset: number, length: number): Buffer<ArrayBuffer>;
    close(): void;
} | {
    size: number;
    read(offset: number, length: number): Uint8Array<ArrayBufferLike>;
    close(): void;
}>;
/** Reopen the demuxer on the same reader after the cheap key-frame packet scan. */
export declare function openVideoFormat(reader: VideoReader, signal?: AbortSignal): ffmpeg.InputFormatContext;
