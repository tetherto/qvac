"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIDEO_DEFAULTS = exports.VIDEO_LIMITS = void 0;
exports.videoError = videoError;
exports.checkCancelled = checkCancelled;
exports.resolveVideoOptions = resolveVideoOptions;
exports.validateDimensions = validateDimensions;
exports.outputDimensions = outputDimensions;
exports.samplingIntervalMs = samplingIntervalMs;
exports.keyframesSuitable = keyframesSuitable;
const error_1 = require("../utils/error");
/** All video policy defaults and safety limits live here. Units are explicit. */
exports.VIDEO_LIMITS = Object.freeze({
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
exports.VIDEO_DEFAULTS = Object.freeze({
    mode: "auto",
    fps: 2,
    maxFrames: exports.VIDEO_LIMITS.maxFrames,
    maxDurationS: exports.VIDEO_LIMITS.maxDurationS,
    maxDimension: 448,
    maxInputBytes: exports.VIDEO_LIMITS.maxInputBytes,
    maxOutputBytes: exports.VIDEO_LIMITS.maxOutputBytes,
});
function videoError(code, detail, cause) {
    return new error_1.QvacErrorDecoderAudio({ code, adds: [detail], cause });
}
function checkCancelled(signal) {
    if (signal?.aborted) {
        throw videoError(error_1.ERR_CODES.JOB_CANCELLED, "Video extraction cancelled");
    }
}
function resolveVideoOptions(options) {
    const config = { ...exports.VIDEO_DEFAULTS, ...options };
    if (!["auto", "uniform", "keyframes"].includes(config.mode)) {
        throw videoError(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Unknown sampling mode");
    }
    const limits = {
        fps: exports.VIDEO_LIMITS.maxFps,
        maxFrames: exports.VIDEO_LIMITS.maxFrames,
        maxDurationS: exports.VIDEO_LIMITS.maxDurationS,
        maxDimension: exports.VIDEO_LIMITS.maxDimension,
        maxInputBytes: exports.VIDEO_LIMITS.maxInputBytes,
        maxOutputBytes: exports.VIDEO_LIMITS.maxOutputBytes,
    };
    for (const key of Object.keys(limits)) {
        const value = config[key];
        if (!Number.isFinite(value) || value <= 0 || value > limits[key] ||
            (key !== "fps" && key !== "maxDurationS" && !Number.isSafeInteger(value))) {
            throw videoError(error_1.ERR_CODES.INVALID_VIDEO_INPUT, `${key} must be positive and at most ${limits[key]}`);
        }
    }
    return config;
}
function validateDimensions(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0 || width > exports.VIDEO_LIMITS.maxSourceDimension ||
        height > exports.VIDEO_LIMITS.maxSourceDimension || width * height > exports.VIDEO_LIMITS.maxSourcePixels) {
        throw videoError(error_1.ERR_CODES.VIDEO_LIMIT_EXCEEDED, "Unsupported source dimensions");
    }
}
function outputDimensions(width, height, maxDimension) {
    validateDimensions(width, height);
    const edge = Math.max(width, height);
    if (edge <= maxDimension)
        return { width, height };
    // Multiply first: 720 * (448 / 1280) can round below 252 and lose a pixel.
    return { width: Math.max(1, Math.floor(width * maxDimension / edge)), height: Math.max(1, Math.floor(height * maxDimension / edge)) };
}
/** Thin over the WHOLE clip, rather than taking only the first maxFrames frames. */
function samplingIntervalMs(durationMs, fps, maxFrames) {
    return Math.max(1000 / fps, durationMs / maxFrames);
}
/** A mean alone would hide long gaps. Include leading/trailing gaps and dense bursts. */
function keyframesSuitable(timesMs, durationMs) {
    if (!timesMs.length || durationMs <= 0)
        return false;
    const times = [...timesMs].sort((a, b) => a - b);
    const rate = times.length * 1000 / durationMs;
    if (rate < exports.VIDEO_LIMITS.minKeyframesPerSecond || rate > exports.VIDEO_LIMITS.maxKeyframesPerSecond)
        return false;
    let previous = 0;
    let windowStart = 0;
    for (let i = 0; i < times.length; i++) {
        const time = times[i];
        if (!Number.isFinite(time) || time < 0 || time > durationMs ||
            time - previous > exports.VIDEO_LIMITS.maxKeyframeGapMs + exports.VIDEO_LIMITS.timestampToleranceMs)
            return false;
        while (time - times[windowStart] >= 1000 - exports.VIDEO_LIMITS.timestampToleranceMs)
            windowStart++;
        if (i - windowStart + 1 > exports.VIDEO_LIMITS.maxKeyframesPerSecond)
            return false;
        previous = time;
    }
    return durationMs - previous <= exports.VIDEO_LIMITS.maxKeyframeGapMs + exports.VIDEO_LIMITS.timestampToleranceMs;
}
