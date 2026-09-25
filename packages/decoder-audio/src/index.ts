/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import QvacLogger = require("@qvac/logging");
import ffmpeg = require("bare-ffmpeg");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  QvacResponse,
  type JobHandler,
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
  maxDecodedBytes?: number;
}

export interface FFmpegDecoderRunOptions {
  retainOutput?: boolean;
  waitForConsumer?: () => Promise<void>;
}

const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;

class StreamingDecoderResponse extends QvacResponse<DecoderOutput> {
  private _iteratorActive = false;
  private _pendingChunk: DecoderOutput | null = null;
  private _wakeIterator: (() => void) | null = null;
  private _resolveConsumption: (() => void) | null = null;
  private _consumption: Promise<void> | null = null;

  override updateOutput(output: DecoderOutput): void {
    if (this._iteratorActive) {
      this._pendingChunk = output;
      this._consumption = new Promise<void>((resolve) => {
        this._resolveConsumption = resolve;
      });
      this._wakeIterator?.();
      this._wakeIterator = null;
    }
    this.emit("output", output);
  }

  waitForConsumption(): Promise<void> {
    return this._consumption ?? Promise.resolve();
  }

  private _takeChunk(): DecoderOutput | null {
    const chunk = this._pendingChunk;
    this._pendingChunk = null;
    this._resolveConsumption?.();
    this._resolveConsumption = null;
    this._consumption = null;
    return chunk;
  }

  override async *iterate(): AsyncIterableIterator<DecoderOutput> {
    if (this._iteratorActive) throw new Error("Only one streaming iterator is supported");
    this._iteratorActive = true;
    let finished = false;
    let failure: Error | undefined;
    const notify = () => {
      this._wakeIterator?.();
      this._wakeIterator = null;
    };
    const onEnd = () => {
      finished = true;
      notify();
    };
    const onError = (error: unknown) => {
      failure = error as Error;
      notify();
    };
    this.on("end", onEnd);
    this.on("error", onError);
    void this.await().then(onEnd, onError);
    try {
      while (true) {
        const chunk = this._takeChunk();
        if (chunk) {
          yield chunk;
        } else if (failure) {
          throw failure;
        } else if (finished) {
          return;
        } else {
          await new Promise<void>((resolve) => { this._wakeIterator = resolve; });
        }
      }
    } finally {
      this._iteratorActive = false;
      this._takeChunk();
      this._wakeIterator = null;
      this.off("end", onEnd);
      this.off("error", onError);
    }
  }
}

interface DecoderRun {
  response: QvacResponse<DecoderOutput>;
  stats: RuntimeStats;
  cancelled: boolean;
  rejectWait: (error: Error) => void;
  cancellation: Promise<never>;
  waitForConsumer: () => Promise<void>;
  samplesSkipped: number;
  totalSkipSamples: number;
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
  maxDecodedBytes: number;
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

  private readonly _job: JobHandler;
  private _runtimeStats!: RuntimeStats;
  private _activeRun: DecoderRun | null = null;

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
      maxDecodedBytes: config.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES,
    };

    this.logger = new QvacLogger(logger ?? undefined);
    this.isLoaded = false;
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
  private _newStats(): RuntimeStats {
    return {
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

  private _resetStats(): void {
    this._runtimeStats = this._newStats();
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

    if (!Number.isSafeInteger(this.config.maxDecodedBytes) || this.config.maxDecodedBytes <= 0) {
      throw new RangeError("maxDecodedBytes must be a positive safe integer");
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
  run(
    audioStream: AsyncIterable<Buffer>,
    options: FFmpegDecoderRunOptions = {},
  ): QvacResponse<DecoderOutput> {
    if (!this.isLoaded) {
      throw new QvacErrorDecoderAudio({ code: ERR_CODES.DECODER_NOT_LOADED });
    }

    this.logger.info("Starting new audio stream processing");

    void this._cancelCurrent();
    let rejectWait!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
    void cancellation.catch(() => {});
    const response = options.retainOutput === false
      ? this._job.startWith(new StreamingDecoderResponse({ cancelHandler: () => this._cancelCurrent() })) as QvacResponse<DecoderOutput>
      : this._job.start() as QvacResponse<DecoderOutput>;
    const run: DecoderRun = {
      response,
      stats: this._newStats(),
      cancelled: false,
      rejectWait,
      cancellation,
      waitForConsumer: options.waitForConsumer ?? (() => Promise.resolve()),
      samplesSkipped: 0,
      totalSkipSamples: 0,
    };
    this._activeRun = run;
    this._runtimeStats = run.stats;

    void this._processStream(audioStream, run)
      .then(() => {
        response.updateStats({ ...run.stats });
        this._clearRun(run);
        response.ended();
      })
      .catch((err: Error) => {
        this.logger.error("Error processing audio stream:", err);
        response.updateStats({ ...run.stats });
        this._clearRun(run);
        response.failed(err);
      });

    return response;
  }

  private _clearRun(run: DecoderRun): void {
    if (this._activeRun === run) this._activeRun = null;
  }

  private _cancelCurrent(): Promise<void> {
    const run = this._activeRun;
    if (run && !run.cancelled) {
      run.cancelled = true;
      run.rejectWait(new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED }));
    }
    this.logger.debug("Decoder cancel requested");
    return Promise.resolve();
  }

  private _getBufferSize(inputBitrate: number): number {
    const maxBufferSize = 1024 * 1024; // 1MB max
    return Math.min((inputBitrate / 8) * 4, maxBufferSize);
  }

  private async _emitDecodedChunk(chunk: Buffer, sampleCount: number, run: DecoderRun): Promise<void> {
    if (run.cancelled) {
      throw new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED });
    }
    if (chunk.length > this.config.maxDecodedBytes - run.stats.outputBytes) {
      throw new QvacErrorDecoderAudio({ code: ERR_CODES.DECODED_AUDIO_LIMIT_EXCEEDED });
    }
    run.stats.samplesDecoded += sampleCount;
    run.stats.outputBytes += chunk.length;
    run.response.updateOutput({ outputArray: chunk });
    const iteratorReady = run.response instanceof StreamingDecoderResponse
      ? run.response.waitForConsumption()
      : Promise.resolve();
    await Promise.race([
      Promise.all([run.waitForConsumer(), iteratorReady]),
      run.cancellation,
    ]);
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

  private async _processFrame(
    decoder: ffmpeg.CodecContext,
    raw: ffmpeg.Frame,
    resampler: ffmpeg.Resampler,
    run: DecoderRun,
  ): Promise<void> {
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
      if (run.samplesSkipped < run.totalSkipSamples) {
        const samplesToSkip = Math.min(count, run.totalSkipSamples - run.samplesSkipped);
        run.samplesSkipped += samplesToSkip;
        if (this._activeRun === run) this.samplesSkipped = run.samplesSkipped;
        if (samplesToSkip >= count) continue; // Skip entire frame

        // Skip partial frame
        const skipBytes =
          OUTPUT_FORMAT_BYTE_LENGTH * samplesToSkip * output.channelLayout.nbChannels;
        const length =
          OUTPUT_FORMAT_BYTE_LENGTH * (count - samplesToSkip) * output.channelLayout.nbChannels;
        const chunk = Buffer.from(samples.data.subarray(skipBytes, skipBytes + length));
        await this._emitDecodedChunk(chunk, count - samplesToSkip, run);
      } else {
        const length = OUTPUT_FORMAT_BYTE_LENGTH * count * output.channelLayout.nbChannels;
        const chunk = Buffer.from(samples.data.subarray(0, length));
        await this._emitDecodedChunk(chunk, count, run);
      }
    }
  }

  private async _processPacket(
    format: ffmpeg.InputFormatContext,
    packet: ffmpeg.Packet,
    raw: ffmpeg.Frame,
    decoder: ffmpeg.CodecContext,
    resampler: ffmpeg.Resampler,
    run: DecoderRun,
  ): Promise<void> {
    while (format.readFrame(packet)) {
      try {
        if (run.cancelled) {
          throw new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED });
        }
        decoder.sendPacket(packet);
        await this._processFrame(decoder, raw, resampler, run);
      } finally {
        packet.unref();
      }
    }
  }

  private async _processFFmpegStream(format: ffmpeg.InputFormatContext, stream: ffmpeg.Stream, run: DecoderRun): Promise<void> {
    const {
      format: OUTPUT_FORMAT,
      byteLength: OUTPUT_FORMAT_BYTE_LENGTH,
      channelLayout: OUTPUT_CHANNEL_LAYOUT,
    } = this._resolveOutputFormat();
    const OUTPUT_SAMPLE_RATE = this.config.sampleRate;

    this.logger.debug("[FFmpegDecoder] Stream codec:", stream.codec, stream.codecParameters);

    // Track codec info in stats
    run.stats.codecName = stream.codec.name;
    run.stats.inputSampleRate = stream.codecParameters.sampleRate;

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
    run.samplesSkipped = 0;
    run.totalSkipSamples = Math.floor((OUTPUT_SAMPLE_RATE * skipMs) / 1000);
    if (this._activeRun === run) {
      this.samplesSkipped = 0;
      this.totalSkipSamples = run.totalSkipSamples;
    }

    if (run.totalSkipSamples > 0) {
      this.logger.info(
        `[FFmpegDecoder] Skipping ${skipMs}ms (${run.totalSkipSamples} samples) for ${codecName} to remove encoder artifacts`,
      );
    }

    try {
      await this._processPacket(format, packet, raw, decoder, resampler, run);

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
        await this._emitDecodedChunk(chunk, flushCount, run);
      }
    } finally {
      decoder.destroy();
    }
  }

  private async _collectStreamData(audioStream: AsyncIterable<Buffer>, run: DecoderRun): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of audioStream) {
      if (run.cancelled) {
        this.logger.info("[FFmpegDecoder] Job cancelled, stopping stream collection");
        throw new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED });
      }

      chunks.push(chunk);
      totalBytes += chunk.length;
      this.logger.debug(`[FFmpegDecoder] Collected chunk, total bytes: ${totalBytes}`);
    }

    return Buffer.concat(chunks);
  }

  private async _processStream(audioStream: AsyncIterable<Buffer>, run: DecoderRun): Promise<void> {
    const startTime = Date.now();

    this.logger.info("[FFmpegDecoder] Starting stream processing");

    // Collect all audio data from stream
    const audioBuffer = await this._collectStreamData(audioStream, run);
    this.logger.info(`[FFmpegDecoder] Collected ${audioBuffer.length} bytes of audio data`);

    // Track input bytes
    run.stats.inputBytes = audioBuffer.length;

    if (run.cancelled) {
      this.logger.info("[FFmpegDecoder] Job cancelled after data collection");
      run.stats.decodeTimeMs = Date.now() - startTime;
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
    await this._processFFmpegStream(format, stream, run);

    // Calculate final decode time
    run.stats.decodeTimeMs = Date.now() - startTime;

    this.logger.info("[FFmpegDecoder] Stream processing completed successfully");
    this.logger.info(`[FFmpegDecoder] Runtime stats: ${JSON.stringify(run.stats)}`);
  }
}

export { FFmpegDecoder };
