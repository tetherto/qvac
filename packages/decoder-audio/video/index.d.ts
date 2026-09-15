import { type VideoOptions } from "./config";
import type { VideoInput } from "./types";
import { type VideoRotation } from "./rotation";
export { VIDEO_DEFAULTS, VIDEO_LIMITS } from "./config";
export type { VideoOptions } from "./config";
export type { VideoInput, VideoReader } from "./types";
export interface VideoFrame {
    /** Owned packed RGB24 bytes. The caller may retain these after the next yield. */
    rgb: Uint8Array;
    width: number;
    height: number;
    /** Actual decoded presentation time, relative to the first video presentation. */
    ptsMs: number;
}
export interface VideoInfo {
    width: number;
    height: number;
    rotation: VideoRotation;
    durationMs: number;
    codec: string;
    inputBytes: number;
    hdr: boolean;
    samplingMode: "uniform" | "keyframes";
    samplingIntervalMs: number;
    /** Set when auto scanned key-frame packet metadata; not a decoded frame count. */
    keyframes: number | null;
}
export interface VideoStats {
    info: VideoInfo;
    decodedFrames: number;
    sampledFrames: number;
    outputBytes: number;
    elapsedMs: number;
}
/** CPU video extraction; no model or weights are loaded. One active iterator per instance. */
export declare class VideoFrameDecoder {
    private readonly config;
    private active;
    private stats;
    constructor(options?: VideoOptions);
    get runtimeStats(): VideoStats | null;
    /** A chunk iterable is consumed once by this call; use a fresh input for frames(). */
    probe(input: VideoInput, options?: {
        signal?: AbortSignal;
    }): Promise<VideoInfo>;
    frames(input: VideoInput, options?: {
        signal?: AbortSignal;
    }): AsyncGenerator<VideoFrame>;
    private decode;
}
