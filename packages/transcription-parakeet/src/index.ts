/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import fs = require("bare-fs");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";
import type { Readable } from "stream";

import {
  ParakeetInterface,
  type BackendInfo as ParakeetBackendInfo,
  type ParakeetBinding,
  type ParakeetConfigurationParams,
  type StreamingConfig,
} from "./parakeet";
import {
  END_OF_INPUT,
  ERR_CODES,
  QvacErrorAddonParakeet,
} from "./lib/error";
import { toFloat32Chunk } from "./lib/audio";

/** Model type auto-detected from the loaded GGUF metadata. */
type ModelType = "tdt" | "ctc" | "eou" | "sortformer";

/** Parakeet-specific configuration options. */
interface ParakeetConfig {
  /** Maximum CPU threads for inference (0 lets the engine pick). */
  maxThreads?: number;
  /** Enable the linked ggml GPU backend (Metal / Vulkan / OpenCL). */
  useGPU?: boolean;
  /** Audio sample rate in Hz (default: 16000; engine assumes 16 kHz). */
  sampleRate?: number;
  /** Number of audio channels (default: 1, must be mono). */
  channels?: number;
  /** Enable caption/subtitle mode (default: false). */
  captionEnabled?: boolean;
  /** Include timestamps in output (default: true). */
  timestampsEnabled?: boolean;
  /** Random seed for reproducibility (-1 for random, default: -1). */
  seed?: number;
  /**
   * Open a long-lived streaming session at load time. Cross-append state is
   * preserved within one `run()` call, but not across separate calls.
   */
  streaming?: boolean;
  /** Streaming chunk cadence in milliseconds (default: 2000). */
  streamingChunkMs?: number;
  /** Sortformer rolling-history window in ms (default: 30000). */
  streamingHistoryMs?: number;
  /** Emit partial segments before chunk boundaries (default: true). */
  streamingEmitPartials?: boolean;
  /** CTC/TDT-only energy-VAD events (default: false). */
  streamingEnergyVad?: boolean;
  /** ASR encoder left-context window in milliseconds. */
  streamingLeftContextMs?: number;
  /** ASR encoder right-lookahead window in milliseconds. */
  streamingRightLookaheadMs?: number;
  /** Enable v2.1 Sortformer AOSC speaker-cache streaming (default: true). */
  streamingSpkCacheEnable?: boolean;
  /** AOSC long-term speaker-cache rows (default: 188). */
  streamingSpkCacheLen?: number;
  /** AOSC FIFO warmup buffer rows (default: 188). */
  streamingFifoLen?: number;
  /** AOSC encoder left-context window in ms (default: 80). */
  streamingChunkLeftContextMs?: number;
  /** AOSC encoder right-context window in ms (default: 560). */
  streamingChunkRightContextMs?: number;
  /** AOSC FIFO-overflow pop-out count (default: 144). */
  streamingSpkCacheUpdatePeriod?: number;
  /**
   * Directory containing dynamically-loaded ggml backend libraries. Defaults
   * to the package's own `prebuilds/` folder.
   */
  backendsDir?: string;
  /**
   * Persistent directory for ggml-opencl's compiled program-binary cache.
   * Android-only; ignored on other platforms.
   */
  openclCacheDir?: string;
}

interface TranscriptionParakeetFiles {
  /** Absolute path to a CTC, TDT, EOU, or Sortformer `.gguf` checkpoint. */
  model?: string;
}

interface TranscriptionParakeetArgs {
  files?: TranscriptionParakeetFiles;
  config?: TranscriptionParakeetConfig;
  logger?: QvacLogger.LoggerInterface;
  exclusiveRun?: boolean;
  [key: string]: unknown;
}

interface TranscriptionParakeetConfig {
  enableStats?: boolean;
  parakeetConfig?: ParakeetConfig;
  [key: string]: unknown;
}

interface TranscriptionSegment {
  text: string;
  start: number;
  end: number;
  toAppend: boolean;
  id?: number;
  /** True when this segment ends on a recognized end-of-utterance boundary. */
  isEndOfTurn?: boolean;
  /** True when the segment begins a new SentencePiece word. */
  startsWord?: boolean;
}

type OutputEvent = "JobStarted" | "Output" | "JobEnded" | "Error";

type AppendInput =
  | { type: "audio"; data: ArrayBuffer; priority?: number }
  | { type: "end of job" };

/** Per-call overrides for a duplex streaming session. */
type StreamingRunConfig = StreamingConfig;

interface Addon {
  activate(): Promise<void>;
  append(input: AppendInput): Promise<number>;
  cancel(jobId?: number): Promise<void>;
  loadWeights(weightsData: {
    filename: string;
    chunk: Uint8Array;
    completed: boolean;
  }): Promise<void>;
  getBackendInfo(): ParakeetBackendInfo | null;
  status(): Promise<string>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  reload(config: ParakeetConfig): Promise<void>;
  destroyInstance(): Promise<void>;
  startStreaming(config?: StreamingRunConfig): Promise<number>;
  appendStreamingAudio(
    data: Float32Array | Int16Array | ArrayBuffer | ArrayBufferView,
  ): Promise<boolean>;
  endStreaming(): Promise<void>;
  cancelStreaming(): Promise<void>;
}

interface InferenceClientState {
  configLoaded: boolean;
  weightsLoaded: boolean;
  destroyed: boolean;
}

interface InternalConfig extends TranscriptionParakeetConfig {
  modelPath?: string;
}

type AudioChunk = Uint8Array | Float32Array;
type AudioStream =
  | AsyncIterable<AudioChunk>
  | Iterable<AudioChunk>
  | AudioChunk;

/**
 * High-level Parakeet speech-to-text client backed by qvac-parakeet.cpp.
 * Accepts CTC, TDT, EOU, and Sortformer GGUF checkpoints; model type is
 * auto-detected from GGUF metadata.
 */
class TranscriptionParakeet {
  readonly logger: QvacLogger;
  readonly exclusiveRun: boolean;
  state: InferenceClientState;
  protected addon?: ParakeetInterface;
  protected params: ParakeetConfig;

  protected readonly _config: InternalConfig;
  private _runQueueWaiter: Promise<void>;
  private readonly _job: JobHandler;

  constructor({
    files = {},
    config = {},
    logger = undefined,
    exclusiveRun = true,
  }: TranscriptionParakeetArgs) {
    this.logger = new QvacLogger(logger);
    this.exclusiveRun = !!exclusiveRun;
    this._runQueueWaiter = Promise.resolve();
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false,
    };
    this._config = { ...config, modelPath: files.model };
    this.params = config.parakeetConfig || {};
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() });

    this.logger.debug("TranscriptionParakeet constructor called", {
      params: this.params,
      config: this._config,
    });
    this.validateModelFiles();
  }

  validateModelFiles(): void {
    const modelPath = this._config.modelPath;
    if (modelPath && !fs.existsSync(modelPath)) {
      this.logger.warn("Model file not found", { path: modelPath });
    }
  }

  protected _buildConfigurationParams(): ParakeetConfigurationParams {
    return {
      modelPath: this._config.modelPath || "",
      maxThreads: this.params.maxThreads ?? 4,
      useGPU: this.params.useGPU === true,
      sampleRate: this.params.sampleRate || 16000,
      channels: this.params.channels || 1,
      captionEnabled: this.params.captionEnabled === true,
      timestampsEnabled: this.params.timestampsEnabled !== false,
      seed: this.params.seed ?? -1,
      streaming: this.params.streaming === true,
      streamingChunkMs: this.params.streamingChunkMs ?? 2000,
      streamingHistoryMs: this.params.streamingHistoryMs ?? 30000,
      streamingEmitPartials: this.params.streamingEmitPartials !== false,
      streamingEnergyVad: this.params.streamingEnergyVad === true,
      streamingLeftContextMs: this.params.streamingLeftContextMs ?? -1,
      streamingRightLookaheadMs:
        this.params.streamingRightLookaheadMs ?? -1,
      streamingSpkCacheEnable:
        this.params.streamingSpkCacheEnable !== false,
      streamingSpkCacheLen: this.params.streamingSpkCacheLen,
      streamingFifoLen: this.params.streamingFifoLen,
      streamingChunkLeftContextMs:
        this.params.streamingChunkLeftContextMs,
      streamingChunkRightContextMs:
        this.params.streamingChunkRightContextMs,
      streamingSpkCacheUpdatePeriod:
        this.params.streamingSpkCacheUpdatePeriod,
      backendsDir: this.params.backendsDir,
      openclCacheDir: this.params.openclCacheDir,
    };
  }

  getState(): InferenceClientState {
    return this.state;
  }

  async load(): Promise<void> {
    if (this.state.destroyed) {
      throw new QvacErrorAddonParakeet(ERR_CODES.INSTANCE_DESTROYED);
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info(
        "Reload requested - unloading existing model first",
      );
      await this.unload();
    }
    await this._load();
    this.state.configLoaded = true;
    this.state.weightsLoaded = true;
  }

  async run(
    audioStream: Readable,
  ): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>> {
    const input = audioStream as AudioStream;
    if (this.exclusiveRun) {
      return this._withExclusiveRun(() => this._runInternal(input));
    }
    return this._runInternal(input);
  }

  /**
   * Opens a long-lived native streaming session and forwards chunks as they
   * arrive. Segment updates surface through `response.onUpdate(...)`.
   */
  async runStreaming(
    audioStream: Readable,
    streamingConfig: StreamingRunConfig = {},
  ): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>> {
    const input = audioStream as AudioStream;
    if (this.exclusiveRun) {
      return this._withExclusiveRun(() =>
        this._runStreamingInternal(input, streamingConfig),
      );
    }
    return this._runStreamingInternal(input, streamingConfig);
  }

  private async _withExclusiveRun<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this._runQueueWaiter;
    let release: () => void = () => {};
    this._runQueueWaiter = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  protected async _load(): Promise<void> {
    const configurationParams = this._buildConfigurationParams();
    this.logger.info(
      "Creating Parakeet addon with configuration:",
      configurationParams,
    );
    this.addon = this._createAddon(configurationParams);
    await this.addon.activate();
    this.logger.debug("Addon activated");
  }

  private _runInternal(
    audioStream: AudioStream,
  ): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>> {
    const response =
      this._job.start() as QvacResponse<TranscriptionParakeet.ParakeetRunOutput>;
    let normalized: AsyncIterable<AudioChunk> | Iterable<AudioChunk>;
    try {
      normalized = this._normalizeAudioStream(audioStream);
    } catch (error) {
      this._job.fail(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
    void this._handleAudioStream(normalized).catch((error: unknown) => {
      this._job.fail(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    return Promise.resolve(response);
  }

  private async _runStreamingInternal(
    audioStream: AudioStream,
    streamingConfig: StreamingRunConfig,
  ): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>> {
    const normalized = this._normalizeAudioStream(audioStream);
    const addon = this._requireAddon();
    const response =
      this._job.start() as QvacResponse<TranscriptionParakeet.ParakeetRunOutput>;
    try {
      await addon.startStreaming(streamingConfig || {});
    } catch (error) {
      this._job.fail(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
    void this._pumpStreamingAudio(normalized).catch(
      (error: unknown) => {
        void addon.endStreaming().catch(() => {});
        this._job.fail(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
    return response;
  }

  private async _pumpStreamingAudio(
    audioStream: AsyncIterable<AudioChunk> | Iterable<AudioChunk>,
  ): Promise<void> {
    const addon = this._requireAddon();
    this.logger.debug(
      "Start pumping audio into duplex streaming session",
    );
    for await (const chunk of audioStream) {
      const audioData = toFloat32Chunk(chunk);
      if (audioData.length === 0) continue;
      await addon.appendStreamingAudio(audioData);
    }
    this.logger.debug(
      "Audio stream completed; closing duplex streaming session",
    );
    await addon.endStreaming();
  }

  private async _handleAudioStream(
    audioStream: AsyncIterable<AudioChunk> | Iterable<AudioChunk>,
  ): Promise<void> {
    const addon = this._requireAddon();
    this.logger.debug("Start handling audio stream");
    for await (const chunk of audioStream) {
      this.logger.debug("Appending audio chunk", {
        chunkLength: chunk.length,
      });
      const audioData = toFloat32Chunk(chunk);
      await addon.append({ type: "audio", data: audioData.buffer });
    }
    this.logger.debug("Sending end-of-input signal");
    await addon.append({ type: END_OF_INPUT });
  }

  private _normalizeAudioStream(
    audioStream: AudioStream,
  ): AsyncIterable<AudioChunk> | Iterable<AudioChunk> {
    if (!audioStream) throw new Error("audioStream is required");
    if (
      typeof (audioStream as { [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ] === "function"
    ) {
      return audioStream as AsyncIterable<AudioChunk>;
    }
    if (
      audioStream instanceof Uint8Array ||
      audioStream instanceof Float32Array
    ) {
      return [audioStream];
    }
    if (Array.isArray(audioStream)) {
      return audioStream as AudioChunk[];
    }
    if (
      typeof (audioStream as { [Symbol.iterator]?: unknown })[
        Symbol.iterator
      ] === "function"
    ) {
      return [Uint8Array.from(audioStream as Iterable<number>)];
    }
    throw new Error(
      "Unsupported audio input. Expected stream, TypedArray, or chunk array.",
    );
  }

  private _outputCallback(
    _addon: unknown,
    event: unknown,
    _jobId: number,
    data: unknown,
    error: unknown,
  ): void {
    if (event === "Error") {
      this._job.fail(
        error instanceof Error ? error : new Error(String(error)),
      );
    } else if (event === "Output") {
      this._job.output(data);
    } else if (event === "JobEnded") {
      this._job.end(data);
    }
  }

  async reload(
    newConfig: { parakeetConfig?: Partial<ParakeetConfig> } = {},
  ): Promise<void> {
    return this._withExclusiveRun(async () => {
      this.logger.debug(
        "Reloading addon with new configuration",
        newConfig,
      );
      if (newConfig.parakeetConfig) {
        this.params = { ...this.params, ...newConfig.parakeetConfig };
      }
      const configurationParams = this._buildConfigurationParams();
      await this.cancel();
      this._job.fail(new Error("Model was reloaded"));
      const addon = this._requireAddon();
      await addon.reload(configurationParams);
      await addon.activate();
      this.logger.debug(
        "Addon reloaded and activated successfully",
      );
    });
  }

  protected _createAddon(
    configurationParams: ParakeetConfigurationParams,
  ): ParakeetInterface {
    this.logger.info(
      "Creating Parakeet interface with configuration:",
      configurationParams,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as ParakeetBinding;
    return new ParakeetInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.logger.info.bind(this.logger),
    );
  }

  async unload(): Promise<void> {
    return this._withExclusiveRun(async () => {
      await this.cancel();
      this._job.fail(new Error("Model was unloaded"));
      if (this.addon) await this.addon.destroyInstance();
      this.state.configLoaded = false;
      this.state.weightsLoaded = false;
    });
  }

  async cancel(jobId?: number): Promise<void> {
    if (this.addon?.cancel) await this.addon.cancel(jobId);
    if (this._job.active) {
      this._job.fail(new QvacErrorAddonParakeet(ERR_CODES.JOB_CANCELLED));
    }
  }

  async status(): Promise<string | undefined> {
    return this.addon?.status();
  }

  getBackendInfo(): ParakeetBackendInfo | null {
    return this.addon?.getBackendInfo?.() ?? null;
  }

  async pause(): Promise<void> {
    await this.addon?.pause();
  }

  async unpause(): Promise<void> {
    await this.addon?.activate();
  }

  async destroy(): Promise<void> {
    return this._withExclusiveRun(async () => {
      await this.cancel();
      this._job.fail(new Error("Model was destroyed"));
      if (this.addon) await this.addon.destroyInstance();
      this.state.configLoaded = false;
      this.state.destroyed = true;
    });
  }

  private _requireAddon(): ParakeetInterface {
    if (!this.addon) {
      throw new Error("Parakeet addon is not loaded");
    }
    return this.addon;
  }
}

type NamespaceModelType = ModelType;
type NamespaceParakeetConfig = ParakeetConfig;
type NamespaceTranscriptionParakeetFiles = TranscriptionParakeetFiles;
type NamespaceTranscriptionParakeetArgs = TranscriptionParakeetArgs;
type NamespaceTranscriptionParakeetConfig = TranscriptionParakeetConfig;
type NamespaceTranscriptionSegment = TranscriptionSegment;
type NamespaceOutputEvent = OutputEvent;
type NamespaceAppendInput = AppendInput;
type NamespaceAddon = Addon;
type NamespaceInferenceClientState = InferenceClientState;
type NamespaceStreamingRunConfig = StreamingRunConfig;

// eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging preserves the package's established class namespace API.
namespace TranscriptionParakeet {
  /**
   * Numeric code identifying the compute backend selected by the engine.
   */
  export enum BackendId {
    CPU = 0,
    Metal = 1,
    CUDA = 2,
    Vulkan = 3,
    OpenCL = 4,
    Other = 99,
  }

  /** Runtime statistics returned by the native Parakeet model. */
  export interface RuntimeStats {
    totalTime: number;
    audioDurationMs: number;
    totalSamples: number;
    totalTokens: number;
    totalTranscriptions: number;
    processCalls: number;
    modelLoadMs: number;
    melSpecMs: number;
    encoderMs: number;
    decoderMs: number;
    totalWallMs: number;
    totalEncodedFrames: number;
    backendDevice: number;
    backendId: number;
    gpuUnsupported: number;
    encoderOnCoreml: number;
  }

  export type BackendInfo = ParakeetBackendInfo;
  export type ParakeetRunOutput =
    | TranscriptionSegment[]
    | TranscriptionSegment;
  export type ModelType = NamespaceModelType;
  export type ParakeetConfig = NamespaceParakeetConfig;
  export type TranscriptionParakeetFiles =
    NamespaceTranscriptionParakeetFiles;
  export type TranscriptionParakeetArgs =
    NamespaceTranscriptionParakeetArgs;
  export type TranscriptionParakeetConfig =
    NamespaceTranscriptionParakeetConfig;
  export type TranscriptionSegment = NamespaceTranscriptionSegment;
  export type OutputEvent = NamespaceOutputEvent;
  export type AppendInput = NamespaceAppendInput;
  export type Addon = NamespaceAddon;
  export type InferenceClientState = NamespaceInferenceClientState;
  export type StreamingRunConfig = NamespaceStreamingRunConfig;
}

export = TranscriptionParakeet;
