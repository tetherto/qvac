import type { QvacResponse } from "@qvac/infer-base";

import {
  ParakeetInterface,
  type ParakeetBinding,
  type ParakeetConfigurationParams,
  type StreamingConfig,
} from "./parakeet";
import {
  ERR_CODES_PARAKEET,
  QvacErrorAddonASRGgml,
} from "../../lib/error";
import { END_OF_INPUT } from "../../lib/constants";
import { normalizeAudioStream } from "../../lib/audio";
import type {
  ASRRunOutput,
  ASRStreamOutput,
  AudioInput,
  BackendInfo,
  TranscriptionSegment,
} from "../../lib/types";
import type {
  ASRGgmlFiles,
  ASRGgmlReloadConfig,
  ASRStreamingOptions,
  AsrDriver,
  DriverContext,
  NormalizedAudioStream,
  StreamingSession,
} from "../types";

/**
 * Parakeet-specific configuration options. The model type (CTC, TDT, EOU,
 * or Sortformer) is auto-detected from the loaded GGUF metadata.
 */
export interface ParakeetConfig {
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

/** Parakeet branch of the discriminated engine-config union. */
export interface ParakeetEngineConfig {
  engine: "parakeet";
  parakeetConfig?: ParakeetConfig;
}

/** Per-call overrides for a duplex streaming session. */
export type ParakeetStreamingRunConfig = StreamingConfig;

export interface ParakeetReloadConfig {
  parakeetConfig?: Partial<ParakeetConfig>;
}

const PARAKEET_CONFIG_KEYS: readonly string[] = [
  "maxThreads",
  "useGPU",
  "sampleRate",
  "channels",
  "captionEnabled",
  "timestampsEnabled",
  "seed",
  "streaming",
  "streamingChunkMs",
  "streamingHistoryMs",
  "streamingEmitPartials",
  "streamingEnergyVad",
  "streamingLeftContextMs",
  "streamingRightLookaheadMs",
  "streamingSpkCacheEnable",
  "streamingSpkCacheLen",
  "streamingFifoLen",
  "streamingChunkLeftContextMs",
  "streamingChunkRightContextMs",
  "streamingSpkCacheUpdatePeriod",
  "backendsDir",
  "openclCacheDir",
];

const PARAKEET_STREAMING_OPT_KEYS: readonly string[] = [
  "chunkMs",
  "historyMs",
  "leftContextMs",
  "rightLookaheadMs",
  "emitPartials",
  "emitEnergyVad",
  "spkCacheEnable",
  "spkCacheLen",
  "fifoLen",
  "chunkLeftContextMs",
  "chunkRightContextMs",
  "spkCacheUpdatePeriod",
];

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * Returns the (last) transcription segment of an output payload, or null
 * when the payload is not segment-shaped.
 */
function lastSegmentOf(data: unknown): TranscriptionSegment | null {
  const candidate: unknown = Array.isArray(data)
    ? (data as unknown[])[data.length - 1]
    : data;
  if (isRecord(candidate) && typeof candidate.text === "string") {
    return candidate as TranscriptionSegment;
  }
  return null;
}

/**
 * Returns an ArrayBuffer covering exactly the chunk's samples. Guards
 * against Float32Array views whose backing buffer is larger than the view.
 */
function chunkBuffer(chunk: Float32Array): ArrayBuffer {
  if (
    chunk.byteOffset === 0 &&
    chunk.byteLength === chunk.buffer.byteLength
  ) {
    return chunk.buffer as ArrayBuffer;
  }
  return chunk.buffer.slice(
    chunk.byteOffset,
    chunk.byteOffset + chunk.byteLength,
  ) as ArrayBuffer;
}

/**
 * Parakeet engine driver: owns the `ParakeetInterface`, the parakeet event
 * mapping, and the parakeet streaming lifecycle. Backed by
 * qvac-parakeet.cpp; accepts CTC, TDT, EOU, and Sortformer GGUF
 * checkpoints.
 */
export class ParakeetDriver implements AsrDriver {
  readonly engineType = "parakeet" as const;
  readonly supportsReload = true;

  addon?: ParakeetInterface;
  params: ParakeetConfig;

  private readonly ctx: DriverContext;
  private readonly _files: { model: string };

  constructor(
    ctx: DriverContext,
    files: ASRGgmlFiles,
    config: ParakeetEngineConfig,
  ) {
    this.ctx = ctx;
    this._files = { model: files.model };
    this.params = config.parakeetConfig || {};
  }

  validateConfig(): void {
    for (const key of Object.keys(this.params)) {
      if (!PARAKEET_CONFIG_KEYS.includes(key)) {
        throw new QvacErrorAddonASRGgml({
          code: ERR_CODES_PARAKEET.INVALID_CONFIG,
          adds: `${key} is not a valid parameter for parakeetConfig`,
        });
      }
    }
  }

  normalizeAudio(input: AudioInput): NormalizedAudioStream {
    return normalizeAudioStream(input, "s16le");
  }

  async load(): Promise<void> {
    const configurationParams = this._buildConfigurationParams();
    this.ctx.logger.info(
      "Creating Parakeet addon with configuration:",
      configurationParams,
    );
    this.addon = this._createAddon(configurationParams);
    await this.addon.activate();
    this.ctx.logger.debug("Addon activated");
  }

  async unload(): Promise<void> {
    if (this.addon) await this.addon.destroyInstance();
  }

  async reload(newConfig: ASRGgmlReloadConfig = {}): Promise<void> {
    const overrides = newConfig as ParakeetReloadConfig;
    this.ctx.logger.debug(
      "Reloading addon with new configuration",
      overrides,
    );
    if (overrides.parakeetConfig) {
      this.params = { ...this.params, ...overrides.parakeetConfig };
    }
    const configurationParams = this._buildConfigurationParams();
    await this.cancelActive();
    if (this.ctx.job.active) {
      this.ctx.job.fail(new Error("Model was reloaded"));
    }
    const addon = this._requireAddon();
    await addon.reload(configurationParams);
    await addon.activate();
    this.ctx.logger.debug("Addon reloaded and activated successfully");
  }

  async cancelActive(jobId?: number): Promise<void> {
    if (this.addon?.cancel) await this.addon.cancel(jobId);
    if (this.ctx.job.active) {
      this.ctx.job.fail(
        new QvacErrorAddonASRGgml(ERR_CODES_PARAKEET.JOB_CANCELLED),
      );
    }
  }

  async status(): Promise<string> {
    if (!this.addon?.status) {
      throw new QvacErrorAddonASRGgml({
        code: ERR_CODES_PARAKEET.FAILED_TO_GET_STATUS,
        adds: "addon is not loaded",
      });
    }
    return await this.addon.status();
  }

  getBackendInfo(): BackendInfo | null {
    return this.addon?.getBackendInfo?.() ?? null;
  }

  run(
    audio: NormalizedAudioStream,
  ): Promise<QvacResponse<ASRRunOutput>> {
    const response = this.ctx.job.start() as QvacResponse<ASRRunOutput>;
    void this._pumpBatchAudio(audio).catch((error: unknown) => {
      this.ctx.job.fail(asError(error));
    });
    return Promise.resolve(response);
  }

  async createStreamingSession(
    audio: NormalizedAudioStream,
    opts: ASRStreamingOptions = {},
  ): Promise<StreamingSession> {
    const streamingOpts = this._validateStreamingOptions(opts);
    const addon = this._requireAddon();
    const response = this.ctx.job.start() as QvacResponse<ASRStreamOutput>;
    try {
      await addon.startStreaming(streamingOpts);
    } catch (error) {
      this.ctx.job.fail(asError(error));
      throw error;
    }
    void this._pumpStreamingAudio(audio).catch((error: unknown) => {
      void this.addon?.endStreaming().catch(() => {});
      this.ctx.job.fail(asError(error));
    });
    // `endStreaming` already resets the interface state, so settlement of
    // the response is the end of driver teardown.
    const done = response.await().then(
      () => {},
      () => {},
    );
    return { response, done };
  }

  _validateStreamingOptions(
    opts: ASRStreamingOptions,
  ): ParakeetStreamingRunConfig {
    for (const key of Object.keys(opts)) {
      if (!PARAKEET_STREAMING_OPT_KEYS.includes(key)) {
        throw new QvacErrorAddonASRGgml({
          code: ERR_CODES_PARAKEET.INVALID_CONFIG,
          adds: `${key} is not a valid parakeet streaming option`,
        });
      }
    }
    return opts as ParakeetStreamingRunConfig;
  }

  async _pumpBatchAudio(audio: NormalizedAudioStream): Promise<void> {
    const addon = this._requireAddon();
    this.ctx.logger.debug("Start handling audio stream");
    for await (const chunk of audio) {
      // Teardown (cancel/unload/destroy/reload) runs on its own queue and can
      // pre-empt an in-flight run: once the job is gone there is nothing to
      // append to, and appending would hit a destroyed native instance.
      if (!this.ctx.job.active) {
        this.ctx.logger.debug("Job is no longer active; stopping audio pump");
        return;
      }
      this.ctx.logger.debug("Appending audio chunk", {
        chunkLength: chunk.length,
      });
      await addon.append({ type: "audio", data: chunkBuffer(chunk) });
    }
    if (!this.ctx.job.active) return;
    this.ctx.logger.debug("Sending end-of-input signal");
    await addon.append({ type: END_OF_INPUT });
  }

  async _pumpStreamingAudio(audio: NormalizedAudioStream): Promise<void> {
    const addon = this._requireAddon();
    this.ctx.logger.debug(
      "Start pumping audio into duplex streaming session",
    );
    for await (const chunk of audio) {
      if (chunk.length === 0) continue;
      await addon.appendStreamingAudio(chunk);
    }
    this.ctx.logger.debug(
      "Audio stream completed; closing duplex streaming session",
    );
    await addon.endStreaming();
  }

  _buildConfigurationParams(): ParakeetConfigurationParams {
    return {
      engineType: "parakeet",
      modelPath: this._files.model || "",
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

  _createAddon(
    configurationParams: ParakeetConfigurationParams,
  ): ParakeetInterface {
    this.ctx.logger.info(
      "Creating Parakeet interface with configuration:",
      configurationParams,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("../../binding.js") as ParakeetBinding;
    return new ParakeetInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.ctx.logger.info.bind(this.ctx.logger),
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
      this.ctx.job.fail(asError(error));
      return;
    }
    if (event === "Output") {
      // The segment payload passes through untouched; a typed endOfTurn
      // event is additionally synthesized when the (last) segment carries
      // the model's end-of-utterance flag (double-signal).
      this.ctx.job.output(data);
      const segment = lastSegmentOf(data);
      if (segment?.isEndOfTurn === true) {
        this.ctx.job.output({ type: "endOfTurn", source: "model-eou" });
      }
      return;
    }
    if (event === "JobEnded") {
      if (this.ctx.enableStats) this.ctx.job.end(data);
      else this.ctx.job.end();
    }
  }

  private _requireAddon(): ParakeetInterface {
    if (!this.addon) {
      throw new Error("Parakeet addon is not loaded");
    }
    return this.addon;
  }
}
