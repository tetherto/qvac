import { ERR_CODES, QvacErrorDecoderAudio } from "../utils/error";

/** All video policy defaults and safety limits live here. Units are explicit. */
export const VIDEO_LIMITS = Object.freeze({
  maxDurationS: 300,
  maxFrames: 64,
  maxInputBytes: 2 * 1024 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxSourcePixels: 4096 * 2160,
  maxSourceDimension: 8192,
  maxDimension: 1024,
  maxFps: 5,
  minKeyframesPerSecond: 1,
  maxKeyframesPerSecond: 5,
  maxKeyframeGapMs: 1000,
  timestampToleranceMs: 2,
  packetsPerYield: 32,
  ioBufferBytes: 64 * 1024,
  decoderThreads: 2,
});

export const VIDEO_DEFAULTS = Object.freeze({
  mode: "auto" as const,
  fps: 2,
  maxFrames: VIDEO_LIMITS.maxFrames,
  maxDurationS: VIDEO_LIMITS.maxDurationS,
  maxDimension: 448,
  maxInputBytes: VIDEO_LIMITS.maxInputBytes,
  maxOutputBytes: VIDEO_LIMITS.maxOutputBytes,
});

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

export function videoError(code: number, detail: string, cause?: Error) {
  return new QvacErrorDecoderAudio({ code, adds: [detail], cause });
}

export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw videoError(ERR_CODES.JOB_CANCELLED, "Video extraction cancelled");
  }
}

export function resolveVideoOptions(options: VideoOptions) {
  const config = { ...VIDEO_DEFAULTS, ...options };
  if (!["auto", "uniform", "keyframes"].includes(config.mode)) {
    throw videoError(ERR_CODES.INVALID_VIDEO_INPUT, "Unknown sampling mode");
  }
  const limits = {
    fps: VIDEO_LIMITS.maxFps,
    maxFrames: VIDEO_LIMITS.maxFrames,
    maxDurationS: VIDEO_LIMITS.maxDurationS,
    maxDimension: VIDEO_LIMITS.maxDimension,
    maxInputBytes: VIDEO_LIMITS.maxInputBytes,
    maxOutputBytes: VIDEO_LIMITS.maxOutputBytes,
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = config[key];
    if (!Number.isFinite(value) || value <= 0 || value > limits[key] ||
        (key !== "fps" && key !== "maxDurationS" && !Number.isSafeInteger(value))) {
      throw videoError(ERR_CODES.INVALID_VIDEO_INPUT, `${key} must be positive and at most ${limits[key]}`);
    }
  }
  return config;
}

export function validateDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width > VIDEO_LIMITS.maxSourceDimension ||
      height > VIDEO_LIMITS.maxSourceDimension || width * height > VIDEO_LIMITS.maxSourcePixels) {
    throw videoError(ERR_CODES.VIDEO_LIMIT_EXCEEDED, "Unsupported source dimensions");
  }
}

export function outputDimensions(width: number, height: number, maxDimension: number) {
  validateDimensions(width, height);
  const edge = Math.max(width, height);
  if (edge <= maxDimension) return { width, height };
  // Multiply first: 720 * (448 / 1280) can round below 252 and lose a pixel.
  return { width: Math.max(1, Math.floor(width * maxDimension / edge)), height: Math.max(1, Math.floor(height * maxDimension / edge)) };
}

/** Thin over the WHOLE clip, rather than taking only the first maxFrames frames. */
export function samplingIntervalMs(durationMs: number, fps: number, maxFrames: number) {
  return Math.max(1000 / fps, durationMs / maxFrames);
}

/** A mean alone would hide long gaps. Include leading/trailing gaps and dense bursts. */
export function keyframesSuitable(timesMs: number[], durationMs: number) {
  if (!timesMs.length || durationMs <= 0) return false;
  const times = [...timesMs].sort((a, b) => a - b);
  const rate = times.length * 1000 / durationMs;
  if (rate < VIDEO_LIMITS.minKeyframesPerSecond || rate > VIDEO_LIMITS.maxKeyframesPerSecond) return false;
  let previous = 0;
  let windowStart = 0;
  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    if (!Number.isFinite(time) || time < 0 || time > durationMs ||
        time - previous > VIDEO_LIMITS.maxKeyframeGapMs + VIDEO_LIMITS.timestampToleranceMs) return false;
    while (time - times[windowStart] >= 1000 - VIDEO_LIMITS.timestampToleranceMs) windowStart++;
    if (i - windowStart + 1 > VIDEO_LIMITS.maxKeyframesPerSecond) return false;
    previous = time;
  }
  return durationMs - previous <= VIDEO_LIMITS.maxKeyframeGapMs + VIDEO_LIMITS.timestampToleranceMs;
}
