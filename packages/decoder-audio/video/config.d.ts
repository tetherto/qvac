import { QvacErrorDecoderAudio } from "../utils/error";
/** All video policy defaults and safety limits live here. Units are explicit. */
export declare const VIDEO_LIMITS: Readonly<{
    maxDurationS: 300;
    maxFrames: 64;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxSourcePixels: number;
    maxSourceDimension: 8192;
    maxDimension: 1024;
    maxFps: 5;
    minKeyframesPerSecond: 1;
    maxKeyframesPerSecond: 5;
    maxKeyframeGapMs: 1000;
    timestampToleranceMs: 2;
    packetsPerYield: 32;
    ioBufferBytes: number;
    decoderThreads: 2;
}>;
export declare const VIDEO_DEFAULTS: Readonly<{
    mode: "auto";
    fps: 2;
    maxFrames: 64;
    maxDurationS: 300;
    maxDimension: 448;
    maxInputBytes: number;
    maxOutputBytes: number;
}>;
export interface VideoOptions {
    mode?: "auto" | "uniform" | "keyframes";
    fps?: number;
    maxFrames?: number;
    maxDurationS?: number;
    maxDimension?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    /** Optional parent directory for private, per-request chunk staging. */
    tempDirectory?: string;
}
export declare function videoError(code: number, detail: string, cause?: Error): QvacErrorDecoderAudio;
export declare function checkCancelled(signal?: AbortSignal): void;
export declare function resolveVideoOptions(options: VideoOptions): {
    mode: "auto" | "uniform" | "keyframes";
    fps: number;
    maxFrames: number;
    maxDurationS: number;
    maxDimension: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    /** Optional parent directory for private, per-request chunk staging. */
    tempDirectory?: string;
};
export declare function validateDimensions(width: number, height: number): void;
export declare function outputDimensions(width: number, height: number, maxDimension: number): {
    width: number;
    height: number;
};
/** Thin over the WHOLE clip, rather than taking only the first maxFrames frames. */
export declare function samplingIntervalMs(durationMs: number, fps: number, maxFrames: number): number;
/** A mean alone would hide long gaps. Include leading/trailing gaps and dense bursts. */
export declare function keyframesSuitable(timesMs: number[], durationMs: number): boolean;
