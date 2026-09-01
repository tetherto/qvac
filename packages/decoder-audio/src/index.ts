/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import QvacLogger = require("@qvac/logging");
import ffmpeg = require("bare-ffmpeg");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";

import { ERR_CODES, QvacErrorDecoderAudio } from "./utils/error";

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

/** Output constants resolved from `ffmpeg.constants` once `load()` has run. */
interface ResolvedOutputFormat {
  format: number;
  byteLength: number;
  channelLayout: number;
}

/**
 * FFmpeg-based audio decoder (single-threaded)
 */
class FFmpegDecoder {
  SUPPORTED_AUDIO_FORMATS: SupportedAudioFormats = {
    s16le: {
      format: null, // Will be set to ffmpeg.constants.sampleFormats.S16
      byteLength: 2,
    },
    f32le: {
      format: null, // Will be set to ffmpeg.constants.sampleFormats.FLT
      byteLength: 4,
    },
  };

  OUTPUT_CHANNEL_LAYOUT: number | null = null; // Will be set to ffmpeg.constants.channelLayouts.MONO

  config: ResolvedConfig;
  logger: QvacLogger;
  isLoaded: boolean;
  samplesSkipped: number;
  totalSkipSamples: number;

  private _cancelled: boolean;
  private readonly _job: JobHandler;
  private _runtimeStats!: RuntimeStats;

  /**
   * Creates an instance of FFmpegDecoder.
   * @param params - Configuration options. Top-level `streamIndex`, `inputBitrate`
   *   and `audioFormat` act as fallbacks for the matching `config` fields.
   */
  constructor({
    config = {},
    logger = null,
    streamIndex = 0,
    inputBitrate = 192000,
    audioFormat = "s16le",
  }: FFmpegDecoderConstructorParams = {}) {
    this.config = {
      streamIndex: config.streamIndex || streamIndex,
      inputBitrate: config.inputBitrate || inputBitrate,
      audioFormat: config.audioFormat || audioFormat,
      sampleRate: config.sampleRate || 16000,
    };

    this.logger = new QvacLogger(logger ?? undefined);
    this.isLoaded = false;
    this._cancelled = false;
    this._job = createJobHandler({ cancel: () => this._cancelCurrent() });

    // Encoder delay handling
    this.samplesSkipped = 0;
    this.totalSkipSamples = 0;

    // Runtime stats
    this._resetStats();
  }

  /**
   * Resets the runtime stats
   */
  private _resetStats(): void {
    this._runtimeStats = {
      decodeTimeMs: 0,
      inputBytes: 0,
      outputBytes: 0,
      samplesDecoded: 0,
      codecName: null,
      inputSampleRate: 0,
      outputSampleRate: this.config.sampleRate,
      audioFormat: this.config.audioFormat,
    };
  }

  /**
   * Get the current runtime stats
   * @returns Current runtime stats
   */
  runtimeStats(): RuntimeStats {
    return { ...this._runtimeStats };
  }

  /**
   * Load and initialize the decoder
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- preserves the established promise-returning API, so failures surface as rejections rather than synchronous throws.
  async load(): Promise<void> {
    if (this.isLoaded) {
      this.logger.info("FFmpegDecoder already loaded");
      return;
    }

    this.logger.info("Loading FFmpegDecoder with config:", this.config);

    // Initialize format constants
    this.SUPPORTED_AUDIO_FORMATS.s16le.format = ffmpeg.constants.sampleFormats.S16;
    this.SUPPORTED_AUDIO_FORMATS.f32le.format = ffmpeg.constants.sampleFormats.FLT;
    this.OUTPUT_CHANNEL_LAYOUT = ffmpeg.constants.channelLayouts.MONO;

    // Validate audio format
    if (!this.SUPPORTED_AUDIO_FORMATS[this.config.audioFormat]) {
      throw new QvacErrorDecoderAudio({
        code: ERR_CODES.UNSUPPORTED_AUDIO_FORMAT,
        adds: this.config.audioFormat,
      });
    }

    this.isLoaded = true;
    this.logger.info("FFmpegDecoder loaded successfully");
  }

  /**
   * Unload the decoder and clean up resources
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- preserves the established promise-returning API, so failures surface as rejections rather than synchronous throws.
  async unload(): Promise<void> {
    if (!this.isLoaded) {
      return;
    }

    this.logger.info("Unloading FFmpegDecoder");

    this.isLoaded = false;
    void this._cancelCurrent();
    this._job.fail(new QvacErrorDecoderAudio({ code: ERR_CODES.DECODER_NOT_LOADED }));
    this.logger.info("FFmpegDecoder unloaded");
  }

  /**
   * Run the decoder on an audio stream
   * @param audioStream - Input audio stream
   * @returns Response with decoded audio
   */
  run(audioStream: AsyncIterable<Buffer>): QvacResponse<DecoderOutput> {
    if (!this.isLoaded) {
      throw new QvacErrorDecoderAudio({ code: ERR_CODES.DECODER_NOT_LOADED });
    }

    this.logger.info("Starting new audio stream processing");

    this._cancelled = false;
    const response = this._job.start() as QvacResponse<DecoderOutput>;

    void this._processStream(audioStream)
      .then(() => {
        this._job.end(this.runtimeStats());
      })
      .catch((err: Error) => {
        this.logger.error("Error processing audio stream:", err);
        this._job.active?.updateStats(this.runtimeStats());
        this._job.fail(err);
      });

    return response;
  }

  private _cancelCurrent(): Promise<void> {
    this._cancelled = true;
    this.logger.debug("Decoder cancel requested");
    return Promise.resolve();
  }

  private _getBufferSize(inputBitrate: number): number {
    const maxBufferSize = 1024 * 1024; // 1MB max
    return Math.min((inputBitrate / 8) * 4, maxBufferSize);
  }

  /**
   * Resolves the output constants populated by `load()`. Unreachable before
   * `load()` succeeds, since every caller sits behind the `isLoaded` guard.
   */
  private _resolveOutputFormat(): ResolvedOutputFormat {
    const audioFormat = this.SUPPORTED_AUDIO_FORMATS[this.config.audioFormat];

    if (audioFormat.format === null || this.OUTPUT_CHANNEL_LAYOUT === null) {
      throw new QvacErrorDecoderAudio({ code: ERR_CODES.DECODER_NOT_LOADED });
    }

    return {
      format: audioFormat.format,
      byteLength: audioFormat.byteLength,
      channelLayout: this.OUTPUT_CHANNEL_LAYOUT,
    };
  }

  private _processFrame(
    decoder: ffmpeg.CodecContext,
    raw: ffmpeg.Frame,
    resampler: ffmpeg.Resampler,
  ): void {
    const {
      format: OUTPUT_FORMAT,
      byteLength: OUTPUT_FORMAT_BYTE_LENGTH,
      channelLayout: OUTPUT_CHANNEL_LAYOUT,
    } = this._resolveOutputFormat();
    const OUTPUT_SAMPLE_RATE = this.config.sampleRate;

    while (decoder.receiveFrame(raw)) {
      const output = new ffmpeg.Frame();
      output.channelLayout = OUTPUT_CHANNEL_LAYOUT;
      output.format = OUTPUT_FORMAT;
      output.sampleRate = OUTPUT_SAMPLE_RATE;
      output.nbSamples = raw.nbSamples;

      const samples = new ffmpeg.Samples();
      samples.fill(output);

      const count = resampler.convert(raw, output);

      // Handle encoder delay by skipping initial samples
      if (this.samplesSkipped < this.totalSkipSamples) {
        const samplesToSkip = Math.min(count, this.totalSkipSamples - this.samplesSkipped);
        this.samplesSkipped += samplesToSkip;
        if (samplesToSkip >= count) continue; // Skip entire frame

        // Skip partial frame
        const skipBytes =
          OUTPUT_FORMAT_BYTE_LENGTH * samplesToSkip * output.channelLayout.nbChannels;
        const length =
          OUTPUT_FORMAT_BYTE_LENGTH * (count - samplesToSkip) * output.channelLayout.nbChannels;
        const chunk = Buffer.from(samples.data.subarray(skipBytes, skipBytes + length));
        this._job.output({ outputArray: chunk });

        // Track stats for partial frame
        this._runtimeStats.samplesDecoded += count - samplesToSkip;
        this._runtimeStats.outputBytes += length;
      } else {
        const length = OUTPUT_FORMAT_BYTE_LENGTH * count * output.channelLayout.nbChannels;
        const chunk = Buffer.from(samples.data.subarray(0, length));
        this._job.output({ outputArray: chunk });

        // Track stats
        this._runtimeStats.samplesDecoded += count;
        this._runtimeStats.outputBytes += length;
      }
    }
  }

  private _processPacket(
    format: ffmpeg.InputFormatContext,
    packet: ffmpeg.Packet,
    raw: ffmpeg.Frame,
    decoder: ffmpeg.CodecContext,
    resampler: ffmpeg.Resampler,
  ): void {
    while (format.readFrame(packet)) {
      if (this._cancelled) {
        packet.unref();
        throw new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED });
      }
      decoder.sendPacket(packet);
      this._processFrame(decoder, raw, resampler);
      packet.unref();
    }
  }

  private _processFFmpegStream(format: ffmpeg.InputFormatContext, stream: ffmpeg.Stream): void {
    const {
      format: OUTPUT_FORMAT,
      byteLength: OUTPUT_FORMAT_BYTE_LENGTH,
      channelLayout: OUTPUT_CHANNEL_LAYOUT,
    } = this._resolveOutputFormat();
    const OUTPUT_SAMPLE_RATE = this.config.sampleRate;

    this.logger.debug("[FFmpegDecoder] Stream codec:", stream.codec, stream.codecParameters);

    // Track codec info in stats
    this._runtimeStats.codecName = stream.codec.name;
    this._runtimeStats.inputSampleRate = stream.codecParameters.sampleRate;

    const packet = new ffmpeg.Packet();
    const raw = new ffmpeg.Frame();

    const resampler = new ffmpeg.Resampler(
      stream.codecParameters.sampleRate,
      stream.codecParameters.channelLayout,
      stream.codecParameters.format,
      OUTPUT_SAMPLE_RATE,
      OUTPUT_CHANNEL_LAYOUT,
      OUTPUT_FORMAT,
    );

    const decoder = stream.decoder();
    decoder.open();

    // Auto-detect encoder delay: lossy codecs need ~400ms skipped to remove artifacts
    const codecName = stream.codec.name.toLowerCase();
    const SKIP_MS: Record<string, number | undefined> = {
      mp3: 400,
      vorbis: 400,
      opus: 150,
      aac: 300,
    };

    const skipMs = SKIP_MS[codecName] || 0;
    this.samplesSkipped = 0;
    this.totalSkipSamples = Math.floor((OUTPUT_SAMPLE_RATE * skipMs) / 1000);

    if (this.totalSkipSamples > 0) {
      this.logger.info(
        `[FFmpegDecoder] Skipping ${skipMs}ms (${this.totalSkipSamples} samples) for ${codecName} to remove encoder artifacts`,
      );
    }

    this._processPacket(format, packet, raw, decoder, resampler);

    // Flush resampler
    const output = new ffmpeg.Frame();
    output.channelLayout = OUTPUT_CHANNEL_LAYOUT;
    output.format = OUTPUT_FORMAT;
    output.sampleRate = OUTPUT_SAMPLE_RATE;
    output.nbSamples = 1024;

    const samples = new ffmpeg.Samples();
    samples.fill(output);

    let flushCount;
    while ((flushCount = resampler.flush(output)) > 0) {
      const actualLength =
        OUTPUT_FORMAT_BYTE_LENGTH * flushCount * output.channelLayout.nbChannels;
      const chunk = Buffer.from(samples.data.subarray(0, actualLength));
      this._job.output({ outputArray: chunk });

      // Track stats for flushed samples
      this._runtimeStats.samplesDecoded += flushCount;
      this._runtimeStats.outputBytes += actualLength;
    }

    decoder.destroy();
  }

  private async _collectStreamData(audioStream: AsyncIterable<Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of audioStream) {
      if (this._cancelled) {
        this.logger.info("[FFmpegDecoder] Job cancelled, stopping stream collection");
        throw new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED });
      }

      chunks.push(chunk);
      totalBytes += chunk.length;
      this.logger.debug(`[FFmpegDecoder] Collected chunk, total bytes: ${totalBytes}`);
    }

    return Buffer.concat(chunks);
  }

  private async _processStream(audioStream: AsyncIterable<Buffer>): Promise<void> {
    // Reset and start tracking stats
    this._resetStats();
    const startTime = Date.now();

    this.logger.info("[FFmpegDecoder] Starting stream processing");

    // Collect all audio data from stream
    const audioBuffer = await this._collectStreamData(audioStream);
    this.logger.info(`[FFmpegDecoder] Collected ${audioBuffer.length} bytes of audio data`);

    // Track input bytes
    this._runtimeStats.inputBytes = audioBuffer.length;

    if (this._cancelled) {
      this.logger.info("[FFmpegDecoder] Job cancelled after data collection");
      this._runtimeStats.decodeTimeMs = Date.now() - startTime;
      throw new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED });
    }

    // Create FFmpeg IO context with the buffer
    const bufferSize = this._getBufferSize(this.config.inputBitrate);
    let bufferOffset = 0;

    const io = new ffmpeg.IOContext(bufferSize, {
      onread: (buffer, requestedLen) => {
        const remainingBytes = audioBuffer.length - bufferOffset;
        const bytesToRead = Math.min(requestedLen, remainingBytes);

        if (bytesToRead <= 0) {
          return 0; // EOF
        }

        audioBuffer.copy(buffer, 0, bufferOffset, bufferOffset + bytesToRead);
        bufferOffset += bytesToRead;

        this.logger.debug(
          `[FFmpegDecoder] Read ${bytesToRead} bytes from buffer, offset now: ${bufferOffset}`,
        );
        return bytesToRead;
      },
      onseek: (offset, whence) => {
        const AVSEEK_SIZE = 0x10000;

        if (whence === AVSEEK_SIZE) {
          return audioBuffer.length;
        }

        let newOffset;
        if (whence === 0) {
          newOffset = offset;
        } else if (whence === 1) {
          newOffset = bufferOffset + offset;
        } else if (whence === 2) {
          newOffset = audioBuffer.length + offset;
        } else {
          return -1;
        }

        if (newOffset < 0 || newOffset > audioBuffer.length) {
          return -1;
        }

        bufferOffset = newOffset;
        this.logger.debug(`[FFmpegDecoder] Seek to offset: ${bufferOffset}`);
        return bufferOffset;
      },
    });

    this.logger.debug("[FFmpegDecoder] IOContext created");
    const format = new ffmpeg.InputFormatContext(io);
    this.logger.debug("[FFmpegDecoder] InputFormatContext created");

    const streamIndex = this.config.streamIndex || 0;
    const stream = format.streams[streamIndex] as ffmpeg.Stream | undefined;
    if (stream === undefined) {
      throw new QvacErrorDecoderAudio({
        code: ERR_CODES.STREAM_INDEX_OUT_OF_BOUNDS,
        adds: [streamIndex],
      });
    }

    // Process the stream and generate decoded output
    this._processFFmpegStream(format, stream);

    // Calculate final decode time
    this._runtimeStats.decodeTimeMs = Date.now() - startTime;

    this.logger.info("[FFmpegDecoder] Stream processing completed successfully");
    this.logger.info(`[FFmpegDecoder] Runtime stats: ${JSON.stringify(this._runtimeStats)}`);
  }
}

export { FFmpegDecoder };
