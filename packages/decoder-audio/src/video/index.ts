/* eslint-disable @typescript-eslint/no-require-imports -- bare-ffmpeg is CommonJS. */
import ffmpeg = require("bare-ffmpeg");
/* eslint-enable @typescript-eslint/no-require-imports */
import { ERR_CODES, QvacErrorDecoderAudio } from "../utils/error";
import { checkCancelled, keyframesSuitable, outputDimensions, resolveVideoOptions,
  samplingIntervalMs, validateDimensions, videoError, VIDEO_LIMITS, type VideoOptions } from "./config";
import { openVideoFormat, prepareVideoInput } from "./input";
import type { VideoInput, VideoReader } from "./types";
import { displayRotation, rotateRgb, type VideoRotation } from "./rotation";

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

function yieldToRuntime() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function selectStream(format: ffmpeg.InputFormatContext) {
  const stream = format.streams.find((entry) => entry.codecParameters.type === 0); // AVMEDIA_TYPE_VIDEO
  if (!stream) throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "No video stream");
  return stream;
}

function timeMultiplier(stream: ffmpeg.Stream) {
  const { numerator, denominator } = stream.timeBase;
  if (numerator <= 0 || denominator <= 0) throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "Invalid video time base");
  return 1000 * numerator / denominator;
}

function validPts(pts: number) {
  return Number.isSafeInteger(pts); // also rejects AV_NOPTS_VALUE (INT64_MIN)
}

function metadata(format: ffmpeg.InputFormatContext, stream: ffmpeg.Stream, config: ReturnType<typeof resolveVideoOptions>, inputBytes: number): VideoInfo {
  const params = stream.codecParameters;
  validateDimensions(params.width, params.height);
  const aspect = params.sampleAspectRatio;
  if (aspect.numerator > 0 && aspect.denominator > 0 && aspect.numerator !== aspect.denominator) {
    throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "Non-square pixel aspect ratios are unsupported");
  }
  const durationMs = stream.duration > 0 ? stream.duration * timeMultiplier(stream) : format.duration / 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "A finite video duration is required");
  if (durationMs > config.maxDurationS * 1000 + VIDEO_LIMITS.timestampToleranceMs) {
    throw videoError(ERR_CODES.VIDEO_LIMIT_EXCEEDED, `Duration exceeds ${config.maxDurationS} seconds`);
  }
  const matrix = stream.sideData.find((entry) => entry.name === "Display Matrix");
  return {
    width: params.width, height: params.height, rotation: displayRotation(matrix?.data),
    durationMs, codec: stream.codec.name, inputBytes,
    hdr: params.colorTRC === 16 || params.colorTRC === 18,
    samplingMode: config.mode === "keyframes" ? "keyframes" : "uniform",
    samplingIntervalMs: samplingIntervalMs(durationMs, config.fps, config.maxFrames),
    keyframes: null,
  };
}

async function inspectVideo(reader: VideoReader, config: ReturnType<typeof resolveVideoOptions>, signal?: AbortSignal) {
  const format = openVideoFormat(reader, signal);
  try {
    const stream = selectStream(format);
    const info = metadata(format, stream, config, reader.size);
    if (config.mode === "uniform") return { info, startPts: null };
    const packet = new ffmpeg.Packet();
    const times: number[] = [];
    let firstPts = Infinity;
    let missingPts = false;
    let packets = 0;
    const multiplier = timeMultiplier(stream);
    try {
      // Metadata-only pass: decode no pixels. Reopen the seekable input for extraction.
      while (format.readFrame(packet)) {
        try {
          checkCancelled(signal);
          if (packet.streamIndex === stream.index) {
            if (validPts(packet.pts)) {
              firstPts = Math.min(firstPts, packet.pts);
              if (packet.isKeyframe) times.push(packet.pts * multiplier);
            } else missingPts = true;
          }
        } finally { packet.unref(); }
        // No need to retain/scour more metadata once the density cannot qualify.
        if (config.mode === "auto" && times.length > Math.ceil(info.durationMs / 1000 * VIDEO_LIMITS.maxKeyframesPerSecond)) return { info, startPts: null };
        if (times.length > VIDEO_LIMITS.maxDurationS * VIDEO_LIMITS.maxKeyframesPerSecond) {
          throw videoError(ERR_CODES.VIDEO_LIMIT_EXCEEDED, "Too many key frames for key-frame mode");
        }
        if (++packets % VIDEO_LIMITS.packetsPerYield === 0) await yieldToRuntime();
      }
      info.keyframes = times.length;
      if (config.mode === "auto" && !missingPts && keyframesSuitable(times.map((pts) => pts - firstPts * multiplier), info.durationMs)) {
        info.samplingMode = "keyframes";
      }
      return { info, startPts: Number.isFinite(firstPts) ? firstPts : null };
    } finally { packet.destroy(); }
  } finally { format.destroy(); }
}

/** CPU video extraction; no model or weights are loaded. One active iterator per instance. */
export class VideoFrameDecoder {
  private readonly config: ReturnType<typeof resolveVideoOptions>;
  private active = false;
  private stats: VideoStats | null = null;

  constructor(options: VideoOptions = {}) {
    this.config = resolveVideoOptions(options);
  }

  get runtimeStats(): VideoStats | null {
    return this.stats ? { ...this.stats, info: { ...this.stats.info } } : null;
  }

  /** A chunk iterable is consumed once by this call; use a fresh input for frames(). */
  async probe(input: VideoInput, options: { signal?: AbortSignal } = {}) {
    let reader: Awaited<ReturnType<typeof prepareVideoInput>> | undefined;
    try {
      reader = await prepareVideoInput(input, this.config.maxInputBytes, this.config.tempDirectory, options.signal);
      return (await inspectVideo(reader, this.config, options.signal)).info;
    }
    catch (error) { throw wrapVideoError(error); }
    finally { reader?.close(); }
  }

  async *frames(input: VideoInput, options: { signal?: AbortSignal } = {}): AsyncGenerator<VideoFrame> {
    if (this.active) throw videoError(ERR_CODES.INVALID_VIDEO_INPUT, "This decoder already has an active iterator");
    this.active = true;
    this.stats = null;
    const started = Date.now();
    let reader: Awaited<ReturnType<typeof prepareVideoInput>> | undefined;
    try {
      reader = await prepareVideoInput(input, this.config.maxInputBytes, this.config.tempDirectory, options.signal);
      const { info, startPts } = await inspectVideo(reader, this.config, options.signal);
      this.stats = { info, decodedFrames: 0, sampledFrames: 0, outputBytes: 0, elapsedMs: 0 };
      yield* this.decode(reader, info, startPts, options.signal);
    } catch (error) { throw wrapVideoError(error); }
    finally {
      this.active = false;
      if (this.stats) this.stats.elapsedMs = Date.now() - started;
      reader?.close();
    }
  }

  private async *decode(reader: VideoReader, info: VideoInfo, startPts: number | null, signal?: AbortSignal): AsyncGenerator<VideoFrame> {
    const format = openVideoFormat(reader, signal);
    let decoder: ffmpeg.CodecContext | undefined;
    let packet: ffmpeg.Packet | undefined;
    let frame: ffmpeg.Frame | undefined;
    let output: ffmpeg.Frame | undefined;
    let scaler: ffmpeg.Scaler | undefined;
    try {
      const stream = selectStream(format);
      const multiplier = timeMultiplier(stream);
      decoder = stream.decoder();
      const settings = ffmpeg.Dictionary.from({
        threads: String(VIDEO_LIMITS.decoderThreads),
        ...(info.samplingMode === "keyframes" ? { skip_frame: "nokey" } : {}),
      });
      try { decoder.open(settings); } finally { settings.destroy(); }
      packet = new ffmpeg.Packet();
      frame = new ffmpeg.Frame();
      output = new ffmpeg.Frame();
      const dimensions = outputDimensions(info.width, info.height, this.config.maxDimension);
      const image = new ffmpeg.Image("RGB24", dimensions.width, dimensions.height, 1);
      output.width = dimensions.width;
      output.height = dimensions.height;
      image.fill(output);
      let firstPts = startPts;
      let pixelFormat: number | null = null;
      let previousMs = -1;
      let nextSampleMs = 0;
      let packets = 0;
      let eof = false;
      while (!eof) {
        checkCancelled(signal);
        if (!format.readFrame(packet)) {
          packet.unref(); // empty packet signals EOF and drains delayed/B-frames
          eof = true;
        } else if (packet.streamIndex !== stream.index) {
          packet.unref();
          if (++packets % VIDEO_LIMITS.packetsPerYield === 0) await yieldToRuntime();
          continue;
        }
        if (!decoder.sendPacket(packet)) throw videoError(ERR_CODES.VIDEO_DECODE_FAILED, "Decoder refused a packet after draining");
        packet.unref();
        while (decoder.receiveFrame(frame)) {
          try {
            checkCancelled(signal);
            validateDimensions(frame.width, frame.height);
            if (frame.width !== info.width || frame.height !== info.height) throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "Mid-stream resolution changes are unsupported");
            pixelFormat ??= frame.format;
            if (frame.format !== pixelFormat) throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "Mid-stream pixel format changes are unsupported");
            if (!validPts(frame.pts)) throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "Decoded video frame has no presentation timestamp");
            firstPts ??= frame.pts;
            const ptsMs = (frame.pts - firstPts) * multiplier;
            if (ptsMs < previousMs) throw videoError(ERR_CODES.UNSUPPORTED_VIDEO, "Non-monotonic presentation timestamps");
            previousMs = ptsMs;
            if (ptsMs > info.durationMs + VIDEO_LIMITS.timestampToleranceMs) throw videoError(ERR_CODES.INVALID_VIDEO_INPUT, "Frame timestamps exceed the declared duration");
            const stats = this.stats!;
            stats.decodedFrames++;
            if (ptsMs + VIDEO_LIMITS.timestampToleranceMs < nextSampleMs || stats.sampledFrames >= this.config.maxFrames) continue;
            const bytes = dimensions.width * dimensions.height * 3;
            if (bytes > this.config.maxOutputBytes - stats.outputBytes) throw videoError(ERR_CODES.VIDEO_LIMIT_EXCEEDED, "Sampled RGB bytes exceed output budget");
            scaler ??= new ffmpeg.Scaler(frame.format, frame.width, frame.height, "RGB24", dimensions.width, dimensions.height);
            scaler.scale(frame, output);
            image.read(output);
            const rotated = rotateRgb(image.data, dimensions.width, dimensions.height, info.rotation);
            stats.sampledFrames++;
            stats.outputBytes += bytes;
            nextSampleMs = (Math.floor((ptsMs + VIDEO_LIMITS.timestampToleranceMs) / info.samplingIntervalMs) + 1) * info.samplingIntervalMs;
            yield { ...rotated, ptsMs };
          } finally { frame.unref(); }
        }
        if (++packets % VIDEO_LIMITS.packetsPerYield === 0) await yieldToRuntime();
      }
      if (!this.stats?.sampledFrames) throw videoError(ERR_CODES.VIDEO_DECODE_FAILED, "No video frames decoded");
    } finally {
      scaler?.destroy();
      output?.destroy();
      frame?.destroy();
      packet?.destroy();
      decoder?.destroy();
      format.destroy();
    }
  }
}

function wrapVideoError(error: unknown) {
  if (error instanceof QvacErrorDecoderAudio) return error;
  return videoError(ERR_CODES.VIDEO_DECODE_FAILED, "Unable to process video", error instanceof Error ? error : undefined);
}
