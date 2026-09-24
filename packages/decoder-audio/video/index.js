"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VideoFrameDecoder = exports.VIDEO_LIMITS = exports.VIDEO_DEFAULTS = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- bare-ffmpeg is CommonJS. */
const ffmpeg = require("bare-ffmpeg");
/* eslint-enable @typescript-eslint/no-require-imports */
const error_1 = require("../utils/error");
const config_1 = require("./config");
const input_1 = require("./input");
const rotation_1 = require("./rotation");
var config_2 = require("./config");
Object.defineProperty(exports, "VIDEO_DEFAULTS", { enumerable: true, get: function () { return config_2.VIDEO_DEFAULTS; } });
Object.defineProperty(exports, "VIDEO_LIMITS", { enumerable: true, get: function () { return config_2.VIDEO_LIMITS; } });
function yieldToRuntime() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
function selectStream(format) {
    const stream = format.streams.find((entry) => entry.codecParameters.type === 0); // AVMEDIA_TYPE_VIDEO
    if (!stream)
        throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "No video stream");
    return stream;
}
function timeMultiplier(stream) {
    const { numerator, denominator } = stream.timeBase;
    if (numerator <= 0 || denominator <= 0)
        throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Invalid video time base");
    return 1000 * numerator / denominator;
}
function validPts(pts) {
    return Number.isSafeInteger(pts); // also rejects AV_NOPTS_VALUE (INT64_MIN)
}
function metadata(format, stream, config, inputBytes) {
    const params = stream.codecParameters;
    (0, config_1.validateDimensions)(params.width, params.height);
    const aspect = params.sampleAspectRatio;
    if (aspect.numerator > 0 && aspect.denominator > 0 && aspect.numerator !== aspect.denominator) {
        throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Non-square pixel aspect ratios are unsupported");
    }
    const durationMs = stream.duration > 0 ? stream.duration * timeMultiplier(stream) : format.duration / 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0)
        throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "A finite video duration is required");
    if (durationMs > config.maxDurationS * 1000 + config_1.VIDEO_LIMITS.timestampToleranceMs) {
        throw (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_LIMIT_EXCEEDED, `Duration exceeds ${config.maxDurationS} seconds`);
    }
    const matrix = stream.sideData.find((entry) => entry.name === "Display Matrix");
    return {
        width: params.width, height: params.height, rotation: (0, rotation_1.displayRotation)(matrix?.data),
        durationMs, codec: stream.codec.name, inputBytes,
        hdr: params.colorTRC === 16 || params.colorTRC === 18,
        samplingMode: config.mode === "keyframes" ? "keyframes" : "uniform",
        samplingIntervalMs: (0, config_1.samplingIntervalMs)(durationMs, config.fps, config.maxFrames),
        keyframes: null,
    };
}
async function inspectVideo(reader, config, signal) {
    const format = (0, input_1.openVideoFormat)(reader, signal);
    try {
        const stream = selectStream(format);
        const info = metadata(format, stream, config, reader.size);
        if (config.mode === "uniform")
            return { info, startPts: null };
        const packet = new ffmpeg.Packet();
        const times = [];
        let firstPts = Infinity;
        let missingPts = false;
        let packets = 0;
        const multiplier = timeMultiplier(stream);
        try {
            // Metadata-only pass: decode no pixels. Reopen the seekable input for extraction.
            while (format.readFrame(packet)) {
                try {
                    (0, config_1.checkCancelled)(signal);
                    if (packet.streamIndex === stream.index) {
                        if (validPts(packet.pts)) {
                            firstPts = Math.min(firstPts, packet.pts);
                            if (packet.isKeyframe)
                                times.push(packet.pts * multiplier);
                        }
                        else
                            missingPts = true;
                    }
                }
                finally {
                    packet.unref();
                }
                // No need to retain/scour more metadata once the density cannot qualify.
                if (config.mode === "auto" && times.length > Math.ceil(info.durationMs / 1000 * config_1.VIDEO_LIMITS.maxKeyframesPerSecond))
                    return { info, startPts: null };
                if (times.length > config_1.VIDEO_LIMITS.maxDurationS * config_1.VIDEO_LIMITS.maxKeyframesPerSecond) {
                    throw (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_LIMIT_EXCEEDED, "Too many key frames for key-frame mode");
                }
                if (++packets % config_1.VIDEO_LIMITS.packetsPerYield === 0)
                    await yieldToRuntime();
            }
            info.keyframes = times.length;
            if (config.mode === "auto" && !missingPts && (0, config_1.keyframesSuitable)(times.map((pts) => pts - firstPts * multiplier), info.durationMs)) {
                info.samplingMode = "keyframes";
            }
            return { info, startPts: Number.isFinite(firstPts) ? firstPts : null };
        }
        finally {
            packet.destroy();
        }
    }
    finally {
        format.destroy();
    }
}
/** CPU video extraction; no model or weights are loaded. One active iterator per instance. */
class VideoFrameDecoder {
    config;
    active = false;
    stats = null;
    constructor(options = {}) {
        this.config = (0, config_1.resolveVideoOptions)(options);
    }
    get runtimeStats() {
        return this.stats ? { ...this.stats, info: { ...this.stats.info } } : null;
    }
    /** A chunk iterable is consumed once by this call; use a fresh input for frames(). */
    async probe(input, options = {}) {
        let reader;
        try {
            reader = await (0, input_1.prepareVideoInput)(input, this.config.maxInputBytes, this.config.tempDirectory, options.signal);
            return (await inspectVideo(reader, this.config, options.signal)).info;
        }
        catch (error) {
            throw wrapVideoError(error);
        }
        finally {
            reader?.close();
        }
    }
    async *frames(input, options = {}) {
        if (this.active)
            throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "This decoder already has an active iterator");
        this.active = true;
        this.stats = null;
        const started = Date.now();
        let reader;
        try {
            reader = await (0, input_1.prepareVideoInput)(input, this.config.maxInputBytes, this.config.tempDirectory, options.signal);
            const { info, startPts } = await inspectVideo(reader, this.config, options.signal);
            this.stats = { info, decodedFrames: 0, sampledFrames: 0, outputBytes: 0, elapsedMs: 0 };
            yield* this.decode(reader, info, startPts, options.signal);
        }
        catch (error) {
            throw wrapVideoError(error);
        }
        finally {
            this.active = false;
            if (this.stats)
                this.stats.elapsedMs = Date.now() - started;
            reader?.close();
        }
    }
    async *decode(reader, info, startPts, signal) {
        const format = (0, input_1.openVideoFormat)(reader, signal);
        let decoder;
        let packet;
        let frame;
        let output;
        let scaler;
        try {
            const stream = selectStream(format);
            const multiplier = timeMultiplier(stream);
            decoder = stream.decoder();
            const settings = ffmpeg.Dictionary.from({
                threads: String(config_1.VIDEO_LIMITS.decoderThreads),
                ...(info.samplingMode === "keyframes" ? { skip_frame: "nokey" } : {}),
            });
            try {
                decoder.open(settings);
            }
            finally {
                settings.destroy();
            }
            packet = new ffmpeg.Packet();
            frame = new ffmpeg.Frame();
            output = new ffmpeg.Frame();
            const dimensions = (0, config_1.outputDimensions)(info.width, info.height, this.config.maxDimension);
            const image = new ffmpeg.Image("RGB24", dimensions.width, dimensions.height, 1);
            output.width = dimensions.width;
            output.height = dimensions.height;
            image.fill(output);
            let firstPts = startPts;
            let pixelFormat = null;
            let previousMs = -1;
            let nextSampleMs = 0;
            let packets = 0;
            let eof = false;
            while (!eof) {
                (0, config_1.checkCancelled)(signal);
                if (!format.readFrame(packet)) {
                    packet.unref(); // empty packet signals EOF and drains delayed/B-frames
                    eof = true;
                }
                else if (packet.streamIndex !== stream.index) {
                    packet.unref();
                    if (++packets % config_1.VIDEO_LIMITS.packetsPerYield === 0)
                        await yieldToRuntime();
                    continue;
                }
                if (!decoder.sendPacket(packet))
                    throw (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_DECODE_FAILED, "Decoder refused a packet after draining");
                packet.unref();
                while (decoder.receiveFrame(frame)) {
                    try {
                        (0, config_1.checkCancelled)(signal);
                        (0, config_1.validateDimensions)(frame.width, frame.height);
                        if (frame.width !== info.width || frame.height !== info.height)
                            throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Mid-stream resolution changes are unsupported");
                        pixelFormat ??= frame.format;
                        if (frame.format !== pixelFormat)
                            throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Mid-stream pixel format changes are unsupported");
                        if (!validPts(frame.pts))
                            throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Decoded video frame has no presentation timestamp");
                        firstPts ??= frame.pts;
                        const ptsMs = (frame.pts - firstPts) * multiplier;
                        if (ptsMs < previousMs)
                            throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Non-monotonic presentation timestamps");
                        previousMs = ptsMs;
                        if (ptsMs > info.durationMs + config_1.VIDEO_LIMITS.timestampToleranceMs)
                            throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Frame timestamps exceed the declared duration");
                        const stats = this.stats;
                        stats.decodedFrames++;
                        if (ptsMs + config_1.VIDEO_LIMITS.timestampToleranceMs < nextSampleMs || stats.sampledFrames >= this.config.maxFrames)
                            continue;
                        const bytes = dimensions.width * dimensions.height * 3;
                        if (bytes > this.config.maxOutputBytes - stats.outputBytes)
                            throw (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_LIMIT_EXCEEDED, "Sampled RGB bytes exceed output budget");
                        scaler ??= new ffmpeg.Scaler(frame.format, frame.width, frame.height, "RGB24", dimensions.width, dimensions.height);
                        scaler.scale(frame, output);
                        image.read(output);
                        const rotated = (0, rotation_1.rotateRgb)(image.data, dimensions.width, dimensions.height, info.rotation);
                        stats.sampledFrames++;
                        stats.outputBytes += bytes;
                        nextSampleMs = (Math.floor((ptsMs + config_1.VIDEO_LIMITS.timestampToleranceMs) / info.samplingIntervalMs) + 1) * info.samplingIntervalMs;
                        yield { ...rotated, ptsMs };
                    }
                    finally {
                        frame.unref();
                    }
                }
                if (++packets % config_1.VIDEO_LIMITS.packetsPerYield === 0)
                    await yieldToRuntime();
            }
            if (!this.stats?.sampledFrames)
                throw (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_DECODE_FAILED, "No video frames decoded");
        }
        finally {
            scaler?.destroy();
            output?.destroy();
            frame?.destroy();
            packet?.destroy();
            decoder?.destroy();
            format.destroy();
        }
    }
}
exports.VideoFrameDecoder = VideoFrameDecoder;
function wrapVideoError(error) {
    if (error instanceof error_1.QvacErrorDecoderAudio)
        return error;
    return (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_DECODE_FAILED, "Unable to process video", error instanceof Error ? error : undefined);
}
