/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

import {
  ERR_CODES_PARAKEET as ERR_CODES,
  QvacErrorAddonASRGgml,
} from "../../lib/error";
import {
  END_OF_INPUT,
  MAX_BUFFERED_BYTES,
} from "../../lib/constants";
import { mergeFloat32Chunks, pcmS16ToFloat32 } from "../../lib/audio";
import type { BackendInfo } from "../../lib/types";

export type { BackendInfo };

const state = Object.freeze({
  LOADING: "loading",
  LISTENING: "listening",
  PROCESSING: "processing",
  IDLE: "idle",
  PAUSED: "paused",
  STOPPED: "stopped",
});

type ParakeetState = (typeof state)[keyof typeof state];

export interface ParakeetConfigurationParams {
  /** Unified native `createInstance` dispatch key. */
  engineType?: string;
  modelPath?: string;
  maxThreads?: number;
  useGPU?: boolean;
  sampleRate?: number;
  channels?: number;
  captionEnabled?: boolean;
  timestampsEnabled?: boolean;
  seed?: number;
  streaming?: boolean;
  streamingChunkMs?: number;
  streamingHistoryMs?: number;
  streamingEmitPartials?: boolean;
  streamingEnergyVad?: boolean;
  streamingLeftContextMs?: number;
  streamingRightLookaheadMs?: number;
  streamingSpkCacheEnable?: boolean;
  streamingSpkCacheLen?: number;
  streamingFifoLen?: number;
  streamingChunkLeftContextMs?: number;
  streamingChunkRightContextMs?: number;
  streamingSpkCacheUpdatePeriod?: number;
  backendsDir?: string;
  openclCacheDir?: string;
}

export interface StreamingConfig {
  chunkMs?: number;
  historyMs?: number;
  leftContextMs?: number;
  rightLookaheadMs?: number;
  emitPartials?: boolean;
  emitEnergyVad?: boolean;
  spkCacheEnable?: boolean;
  spkCacheLen?: number;
  fifoLen?: number;
  chunkLeftContextMs?: number;
  chunkRightContextMs?: number;
  spkCacheUpdatePeriod?: number;
}

export interface WeightData {
  filename: string;
  chunk: Uint8Array;
  completed: boolean;
  progress?: number;
  size?: number;
}

export type AudioInput =
  | Float32Array
  | Int16Array
  | ArrayBuffer
  | ArrayBufferView;

export type AppendData =
  | { type: "audio"; data?: ArrayBufferLike }
  | { type: typeof END_OF_INPUT };

export type ParakeetOutputCallback = (
  addon: unknown,
  event: unknown,
  jobId: number,
  data: unknown,
  error: unknown,
) => void;

export type ParakeetStateCallback = (
  addon: ParakeetInterface,
  newState: string,
) => void;

type NativeOutputCallback = (
  addon: unknown,
  event: unknown,
  data: unknown,
  error: unknown,
) => void;

interface StreamingTeardown {
  audioDurationMs?: unknown;
  totalSamples?: unknown;
}

export interface ParakeetBinding {
  createInstance(
    owner: ParakeetInterface,
    configurationParams: ParakeetConfigurationParams,
    outputCallback: NativeOutputCallback,
    stateCallback: ParakeetStateCallback | null,
  ): object;
  loadWeights(handle: object | null, weightsData: WeightData): Promise<boolean>;
  activate(handle: object | null): void;
  getBackendInfo(handle: object): BackendInfo | null;
  runJob(
    handle: object | null,
    data: { type: "audio"; input: Float32Array } | Record<string, unknown>,
  ): boolean;
  cancel(handle: object | null): Promise<void>;
  destroyInstance(handle: object): void;
  startStreaming(handle: object | null, config: StreamingConfig): void;
  appendStreamingAudio(
    handle: object | null,
    data: { type: "audio"; input: Float32Array },
  ): boolean;
  endStreaming(handle: object | null): StreamingTeardown | undefined;
}

function nextSafeId(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function normalizeError(error: unknown): {
  message: string;
  cause: Error;
} {
  if (error instanceof Error) {
    return { message: error.message, cause: error };
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return { message, cause: new Error(message) };
    }
  }
  const message = typeof error === "string" ? error : "unknown error";
  return { message, cause: new Error(message) };
}

function createParakeetError(
  code: number,
  message: string,
  error?: unknown,
): QvacErrorAddonASRGgml {
  const cause = error === undefined ? undefined : normalizeError(error).cause;
  return new QvacErrorAddonASRGgml({ code, adds: message, cause });
}

/**
 * Low-level interface between the Bare addon (C++) and the JavaScript runtime.
 * The model type is auto-detected from the loaded GGUF metadata.
 */
export class ParakeetInterface {
  private readonly _binding: ParakeetBinding;
  private readonly _outputCallback: ParakeetOutputCallback;
  private readonly _stateCallback: ParakeetStateCallback | null;
  private _handle: object | null;
  private _state: ParakeetState;
  private _nextJobId: number;
  private _activeJobId: number | null;
  private _onCancelComplete: (() => void) | null;
  private _bufferedAudio: Float32Array[];
  private _bufferedBytes: number;
  private _config: ParakeetConfigurationParams;

  constructor(
    binding: ParakeetBinding,
    configurationParams: ParakeetConfigurationParams,
    outputCallback: ParakeetOutputCallback,
    stateCallback: ParakeetStateCallback | null = null,
  ) {
    this._binding = binding;
    this._outputCallback = outputCallback;
    this._stateCallback = stateCallback;
    this._handle = null;
    this._state = state.LOADING;
    this._nextJobId = 1;
    this._activeJobId = null;
    this._onCancelComplete = null;
    this._bufferedAudio = [];
    this._bufferedBytes = 0;

    this._config = this._applyDefaults(configurationParams);
    this._createNativeInstance(this._config);
  }

  private _applyDefaults(
    configurationParams: ParakeetConfigurationParams,
  ): ParakeetConfigurationParams {
    const out = { ...configurationParams };
    if (!out.backendsDir) {
      // Generated file lives at engines/parakeet/parakeet.js; prebuilds/
      // sits at the package root, two levels up.
      out.backendsDir = path.join(__dirname, "..", "..", "prebuilds");
    }
    return out;
  }

  private _setState(newState: ParakeetState): void {
    this._state = newState;
    if (this._stateCallback) {
      this._stateCallback(this, newState);
    }
  }

  private _createNativeInstance(
    configurationParams: ParakeetConfigurationParams,
  ): void {
    this._config = configurationParams;
    this._activeJobId = null;
    this._onCancelComplete = null;
    this._bufferedAudio = [];
    this._bufferedBytes = 0;
    this._handle = this._binding.createInstance(
      this,
      this._config,
      this._addonOutputCallback.bind(this),
      this._stateCallback,
    );
  }

  private _looksLikeStats(data: unknown): boolean {
    return (
      data !== null &&
      typeof data === "object" &&
      ("totalTime" in data ||
        "audioDurationMs" in data ||
        "totalSamples" in data)
    );
  }

  private _looksLikeTranscript(data: unknown): boolean {
    return (
      Array.isArray(data) ||
      (data !== null &&
        typeof data === "object" &&
        "text" in data &&
        typeof data.text === "string")
    );
  }

  private _mapAddonEvent(
    event: unknown,
    data: unknown,
    isError: boolean,
  ): unknown {
    const eventStr = typeof event === "string" ? event : String(event);
    if (
      eventStr === "Error" ||
      eventStr === "JobEnded" ||
      eventStr === "Output"
    ) {
      return eventStr;
    }
    if (isError || eventStr.includes("Error")) return "Error";
    if (eventStr.includes("RuntimeStats")) return "JobEnded";
    if (eventStr.includes("Output")) return "Output";
    if (this._looksLikeStats(data)) return "JobEnded";
    if (this._looksLikeTranscript(data)) return "Output";
    return event;
  }

  private _resolvePendingCancel(): boolean {
    if (!this._onCancelComplete) return false;
    const resolve = this._onCancelComplete;
    this._onCancelComplete = null;
    resolve();
    return true;
  }

  private _addonOutputCallback(
    addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    const isError = typeof error === "string" && error.length > 0;
    const mappedEvent = this._mapAddonEvent(event, data, isError);
    const isTerminal =
      mappedEvent === "Error" || mappedEvent === "JobEnded";
    const jobId = this._activeJobId;

    if (jobId === null) {
      if (isTerminal) this._resolvePendingCancel();
      return;
    }
    if (isTerminal && this._resolvePendingCancel()) return;
    if (mappedEvent === "Output") this._setState(state.PROCESSING);

    this._outputCallback(
      addon,
      mappedEvent,
      jobId,
      data,
      isError ? error : null,
    );

    if (isTerminal) {
      this._activeJobId = null;
      this._setState(state.LISTENING);
    }
  }

  private _emitSyntheticError(jobId: number, error: string): void {
    this._outputCallback(this, "Error", jobId, undefined, error);
  }

  async loadWeights(weightsData: WeightData): Promise<boolean> {
    try {
      return await this._binding.loadWeights(this._handle, weightsData);
    } catch (error) {
      const normalized = normalizeError(error);
      throw createParakeetError(
        ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        normalized.message,
        error,
      );
    }
  }

  activate(): Promise<void> {
    try {
      this._binding.activate(this._handle);
      this._setState(state.LISTENING);
      return Promise.resolve();
    } catch (error) {
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_ACTIVATE,
          normalized.message,
          error,
        ),
      );
    }
  }

  getBackendInfo(): BackendInfo | null {
    if (this._handle === null) return null;
    return this._binding.getBackendInfo(this._handle);
  }

  append(data: AppendData): Promise<number> {
    try {
      if (data?.type === END_OF_INPUT) {
        return Promise.resolve(this._submitBufferedJob());
      }
      if (data?.type === "audio") {
        return Promise.resolve(this._bufferAudioChunk(data.data));
      }
      const inputType = (data as { type?: unknown } | null)?.type;
      throw new Error(`Unknown append input type: ${String(inputType)}`);
    } catch (error) {
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_APPEND,
          normalized.message,
          error,
        ),
      );
    }
  }

  private _submitBufferedJob(): number {
    const currentJobId = this._nextJobId;
    const input = this._concatBufferedAudio();
    const previousState = this._state;
    let accepted = false;
    try {
      accepted = this._binding.runJob(this._handle, { type: "audio", input });
    } catch (error) {
      this._setState(previousState);
      throw error;
    }
    if (!accepted) {
      this._setState(previousState);
      throw new Error(
        "Cannot set new job: a job is already set or being processed",
      );
    }

    this._activeJobId = currentJobId;
    this._nextJobId = nextSafeId(this._nextJobId);
    this._bufferedAudio = [];
    this._bufferedBytes = 0;
    this._setState(state.PROCESSING);
    return currentJobId;
  }

  private _bufferAudioChunk(rawData: ArrayBufferLike | undefined): number {
    const normalized = this._normalizeAudioInput(rawData);
    if (this._bufferedBytes + normalized.byteLength > MAX_BUFFERED_BYTES) {
      throw createParakeetError(
        ERR_CODES.BUFFER_LIMIT_EXCEEDED,
        MAX_BUFFERED_BYTES + " bytes",
      );
    }
    this._bufferedAudio.push(normalized);
    this._bufferedBytes += normalized.byteLength;
    return this._nextJobId;
  }

  status(): Promise<string> {
    try {
      return Promise.resolve(this._state);
    } catch (error) {
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_GET_STATUS,
          normalized.message,
          error,
        ),
      );
    }
  }

  pause(): Promise<void> {
    try {
      this._setState(state.PAUSED);
      return Promise.resolve();
    } catch (error) {
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_PAUSE,
          normalized.message,
          error,
        ),
      );
    }
  }

  async stop(): Promise<void> {
    try {
      this._bufferedAudio = [];
      this._bufferedBytes = 0;
      if (this._activeJobId !== null) {
        const cancelComplete = new Promise<void>((resolve) => {
          this._onCancelComplete = resolve;
        });
        this._activeJobId = null;
        await this._binding.cancel(this._handle);
        await cancelComplete;
      }
      this._setState(state.STOPPED);
    } catch (error) {
      const normalized = normalizeError(error);
      throw createParakeetError(
        ERR_CODES.FAILED_TO_RESET,
        normalized.message,
        error,
      );
    }
  }

  async cancel(jobId?: number): Promise<void> {
    try {
      const pendingJobId =
        this._bufferedAudio.length > 0 ? this._nextJobId : null;
      const targetJobId = jobId ?? this._activeJobId ?? pendingJobId;

      if (targetJobId === null) {
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        this._setState(state.LISTENING);
        return;
      }

      if (this._activeJobId === targetJobId) {
        const cancelComplete = new Promise<void>((resolve) => {
          this._onCancelComplete = resolve;
        });
        await this._binding.cancel(this._handle);
        await cancelComplete;
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        this._activeJobId = null;
        this._setState(state.LISTENING);
        return;
      }

      if (this._activeJobId === null && pendingJobId === targetJobId) {
        this._bufferedAudio = [];
        this._bufferedBytes = 0;
        this._setState(state.LISTENING);
        this._emitSyntheticError(targetJobId, "Job cancelled");
      }
    } catch (error) {
      const normalized = normalizeError(error);
      throw createParakeetError(
        ERR_CODES.FAILED_TO_CANCEL,
        normalized.message,
        error,
      );
    }
  }

  async reload(
    configurationParams: ParakeetConfigurationParams,
  ): Promise<void> {
    try {
      await this.cancel();
      await this.destroyInstance();
      this._createNativeInstance(configurationParams);
      this._setState(state.LOADING);
    } catch (error) {
      const normalized = normalizeError(error);
      throw createParakeetError(
        ERR_CODES.FAILED_TO_RESET,
        normalized.message,
        error,
      );
    }
  }

  unloadWeights(): Promise<never> {
    return Promise.reject(
      createParakeetError(
        ERR_CODES.FAILED_TO_RESET,
        "unloadWeights is not supported by this package. Use unload() or destroyInstance().",
      ),
    );
  }

  async load(configurationParams: ParakeetConfigurationParams): Promise<void> {
    try {
      await this.destroyInstance();
      this._createNativeInstance(configurationParams);
      this._setState(state.LOADING);
    } catch (error) {
      const normalized = normalizeError(error);
      throw createParakeetError(
        ERR_CODES.FAILED_TO_RESET,
        normalized.message,
        error,
      );
    }
  }

  async unload(): Promise<void> {
    await this.destroyInstance();
  }

  async destroyInstance(): Promise<void> {
    try {
      if (this._handle === null) return;
      if (this._activeJobId !== null) {
        try {
          await this._binding.cancel(this._handle);
        } catch {}
      }
      this._binding.destroyInstance(this._handle);
      this._handle = null;
      this._activeJobId = null;
      this._bufferedAudio = [];
      this._bufferedBytes = 0;
      this._setState(state.IDLE);
    } catch (error) {
      const normalized = normalizeError(error);
      throw createParakeetError(
        ERR_CODES.FAILED_TO_DESTROY,
        normalized.message,
        error,
      );
    }
  }

  runJob(data: Record<string, unknown>): Promise<boolean> {
    const currentJobId = this._nextJobId;
    const previousJobId = this._activeJobId;
    const previousState = this._state;
    try {
      const accepted = this._binding.runJob(this._handle, data);
      if (!accepted) {
        this._activeJobId = previousJobId;
        this._setState(previousState);
        return Promise.resolve(false);
      }
      this._activeJobId = currentJobId;
      this._nextJobId = nextSafeId(this._nextJobId);
      this._setState(state.PROCESSING);
      return Promise.resolve(accepted);
    } catch (error) {
      this._activeJobId = previousJobId;
      this._setState(previousState);
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_APPEND,
          normalized.message,
          error,
        ),
      );
    }
  }

  startStreaming(config: StreamingConfig = {}): Promise<number> {
    try {
      if (this._activeJobId !== null) {
        throw new Error(
          "Cannot start streaming: a job is already active. Call cancel() first.",
        );
      }
      const currentJobId = this._nextJobId;
      this._activeJobId = currentJobId;
      this._nextJobId = nextSafeId(this._nextJobId);
      try {
        this._binding.startStreaming(this._handle, config);
      } catch (error) {
        this._activeJobId = null;
        throw error;
      }
      this._setState(state.PROCESSING);
      return Promise.resolve(currentJobId);
    } catch (error) {
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_APPEND,
          normalized.message,
          error,
        ),
      );
    }
  }

  appendStreamingAudio(data: AudioInput): Promise<boolean> {
    try {
      if (this._activeJobId === null) {
        throw new Error(
          "No active streaming session; call startStreaming() first.",
        );
      }
      const samples = this._normalizeAudioInput(data);
      return Promise.resolve(
        this._binding.appendStreamingAudio(this._handle, {
          type: "audio",
          input: samples,
        }),
      );
    } catch (error) {
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_APPEND,
          normalized.message,
          error,
        ),
      );
    }
  }

  endStreaming(): Promise<void> {
    try {
      if (this._activeJobId === null) return Promise.resolve();
      const jobId = this._activeJobId;
      const teardown = this._binding.endStreaming(this._handle) || {};
      this._activeJobId = null;
      this._setState(state.LISTENING);
      this._outputCallback(
        this,
        "JobEnded",
        jobId,
        {
          totalTime: 0,
          audioDurationMs:
            typeof teardown.audioDurationMs === "number"
              ? teardown.audioDurationMs
              : 0,
          totalSamples:
            typeof teardown.totalSamples === "number"
              ? teardown.totalSamples
              : 0,
        },
        null,
      );
      return Promise.resolve();
    } catch (error) {
      const normalized = normalizeError(error);
      return Promise.reject(
        createParakeetError(
          ERR_CODES.FAILED_TO_RESET,
          normalized.message,
          error,
        ),
      );
    }
  }

  async cancelStreaming(): Promise<void> {
    return this.cancel();
  }

  private _normalizeAudioInput(
    data: AudioInput | ArrayBufferLike | undefined,
  ): Float32Array {
    if (!data) throw new Error("Audio input is required");
    if (data instanceof Float32Array) return data;
    if (ArrayBuffer.isView(data)) {
      if (data instanceof Int16Array) return pcmS16ToFloat32(data);
      return new Float32Array(
        data.buffer,
        data.byteOffset,
        Math.floor(data.byteLength / 4),
      );
    }
    if (data instanceof ArrayBuffer) return new Float32Array(data);
    throw new Error("Unsupported audio input format");
  }

  private _concatBufferedAudio(): Float32Array {
    if (this._bufferedAudio.length === 0) return new Float32Array(0);
    if (this._bufferedAudio.length === 1) return this._bufferedAudio[0];
    return mergeFloat32Chunks(this._bufferedAudio);
  }
}
