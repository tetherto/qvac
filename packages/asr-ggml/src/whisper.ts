/* eslint-disable @typescript-eslint/require-await -- low-level methods intentionally retain their established Promise-based API around synchronous native calls. */
import {
  checkConfig,
  type WhisperConfigurationParams,
} from "./configChecker";
import {
  QvacErrorAddonWhisper,
  ERR_CODES,
} from "./lib/error";

const state = Object.freeze({
  LOADING: "loading",
  LISTENING: "listening",
  PROCESSING: "processing",
  IDLE: "idle",
  PAUSED: "paused",
  STOPPED: "stopped",
});

const END_OF_INPUT = "end of job";
const MAX_BUFFERED_BYTES = 500 * 1024 * 1024;

type AddonState = (typeof state)[keyof typeof state];
type NativeHandle = object;

export interface AudioData {
  type: string;
  input?: Uint8Array;
  audio_format?: string;
}

export interface StreamingConfig {
  vadModelPath?: string;
  vadThreshold?: number;
  minSilenceDurationMs?: number;
  minSpeechDurationMs?: number;
  maxSpeechDurationS?: number;
  speechPadMs?: number;
  samplesOverlap?: number;
  emitVadEvents?: boolean;
  endOfTurnSilenceMs?: number;
  vadRunIntervalMs?: number;
  jobId?: number;
}

export type WhisperOutputCallback = (
  addon: unknown,
  event: string,
  jobId: number,
  data: unknown,
  error: string | null,
) => void;

export type TransitionCallback = (
  addon: WhisperInterface,
  newState: string,
) => void;

type NativeOutputCallback = (
  addon: unknown,
  event: unknown,
  data: unknown,
  error: unknown,
) => void;

export interface WhisperBinding {
  createInstance(
    owner: WhisperInterface,
    configurationParams: WhisperConfigurationParams,
    outputCb: NativeOutputCallback,
    transitionCb: TransitionCallback | null,
  ): NativeHandle;
  reload?(
    handle: NativeHandle,
    configurationParams: WhisperConfigurationParams,
  ): Promise<void> | void;
  loadWeights(handle: NativeHandle, weightsData: unknown): void;
  activate(handle: NativeHandle): void;
  cancel(handle: NativeHandle): Promise<void> | void;
  runJob(handle: NativeHandle, data: AudioData): boolean;
  destroyInstance(handle: NativeHandle): void;
  startStreaming(handle: NativeHandle, config: StreamingConfig): void;
  appendStreamingAudio(handle: NativeHandle, data: AudioData): void;
  endStreaming(handle: NativeHandle): void;
}

function nextSafeId(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return typeof err === "string" ? err : "unknown error";
}

function isErrorString(error: unknown): error is string {
  return typeof error === "string" && error.length > 0;
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return Boolean(data) && typeof data === "object";
}

function isStatsPayload(data: unknown): boolean {
  return (
    isRecord(data) &&
    ("totalTime" in data ||
      "audioDurationMs" in data ||
      "totalSamples" in data)
  );
}

function isVadPayload(data: unknown): boolean {
  return isRecord(data) && data.type === "vad";
}

function isEndOfTurnPayload(data: unknown): boolean {
  return isRecord(data) && data.type === "endOfTurn";
}

function isTranscriptPayload(data: unknown): boolean {
  return (
    (Array.isArray(data) && data.length > 0) ||
    (isRecord(data) && typeof data.text === "string")
  );
}

function classifyEvent(
  event: unknown,
  data: unknown,
  error: unknown,
): string | null {
  if (isVadPayload(data)) return "VadState";
  if (isEndOfTurnPayload(data)) return "EndOfTurn";
  if (
    event === "Error" ||
    isErrorString(error) ||
    String(event).includes("Error")
  ) {
    return "Error";
  }
  if (
    event === "JobEnded" ||
    isStatsPayload(data) ||
    String(event).includes("RuntimeStats")
  ) {
    return "JobEnded";
  }
  if (event === "Output" || isTranscriptPayload(data)) return "Output";
  if (Array.isArray(data) && data.length === 0) return null;
  return String(event);
}

export class WhisperInterface {
  _binding: WhisperBinding;
  _outputCb: WhisperOutputCallback | null;
  _transitionCb: TransitionCallback | null;
  _nextJobId: number;
  _activeJobId: number | null;
  _bufferedAudio: Uint8Array[];
  _bufferedBytes: number;
  _state: AddonState;
  _audioFormat: string;
  _handle: NativeHandle | null;

  constructor(
    binding: WhisperBinding,
    configurationParams: WhisperConfigurationParams,
    outputCb: WhisperOutputCallback | null,
    transitionCb: TransitionCallback | null = null,
  ) {
    this._binding = binding;
    this._outputCb = outputCb;
    this._transitionCb = transitionCb;
    this._nextJobId = 1;
    this._activeJobId = null;
    this._bufferedAudio = [];
    this._bufferedBytes = 0;
    this._state = state.LOADING;
    this._audioFormat = configurationParams?.audio_format || "s16le";

    checkConfig(configurationParams);
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      this._addonOutputCallback.bind(this),
      transitionCb,
    );
  }

  _setState(newState: AddonState): void {
    this._state = newState;
    if (this._transitionCb) this._transitionCb(this, newState);
  }

  _addonOutputCallback(
    addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    const mappedEvent = classifyEvent(event, data, error);
    if (mappedEvent === null) return;

    const jobId = this._activeJobId;
    if (jobId === null) return;

    if (mappedEvent === "Output") {
      this._setState(state.PROCESSING);
      if (this._outputCb) this._emitTranscript(addon, jobId, data);
      return;
    }

    if (this._outputCb) {
      this._outputCb(
        addon,
        mappedEvent,
        jobId,
        data,
        isErrorString(error) ? error : null,
      );
    }

    if (mappedEvent === "Error" || mappedEvent === "JobEnded") {
      this._activeJobId = null;
      this._setState(state.LISTENING);
    }
  }

  _emitTranscript(addon: unknown, jobId: number, data: unknown): void {
    const isTranscriptArray =
      Array.isArray(data) &&
      data.length > 0 &&
      isRecord(data[0]) &&
      typeof data[0].text === "string";
    const isSingleTranscript =
      !Array.isArray(data) &&
      isRecord(data) &&
      typeof data.text === "string";
    if (isTranscriptArray) {
      this._emitSegments(addon, jobId, data);
      return;
    }
    if (isSingleTranscript) {
      this._outputCb?.(addon, "Output", jobId, [data], null);
      return;
    }
    this._outputCb?.(addon, "Output", jobId, data, null);
  }

  _emitSegments(addon: unknown, jobId: number, segments: unknown[]): void {
    for (const segment of segments) {
      this._outputCb?.(addon, "Output", jobId, [segment], null);
    }
  }

  _emitSyntheticError(jobId: number, error: string): void {
    if (!this._outputCb) return;
    this._outputCb(this, "Error", jobId, undefined, error);
  }

  async unload(): Promise<void> {
    await this.destroyInstance();
  }

  async load(configurationParams: WhisperConfigurationParams): Promise<void> {
    checkConfig(configurationParams);
    this._audioFormat =
      configurationParams?.audio_format || this._audioFormat;
    await this.destroyInstance();
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      this._addonOutputCallback.bind(this),
      this._transitionCb,
    );
    this._setState(state.LOADING);
  }

  async reload(configurationParams: WhisperConfigurationParams): Promise<void> {
    checkConfig(configurationParams);
    this._audioFormat =
      configurationParams?.audio_format || this._audioFormat;
    await this.cancel();

    if (typeof this._binding.reload === "function") {
      await this._binding.reload(this._requiredHandle(), configurationParams);
      this._setState(state.LOADING);
      return;
    }
    await this.load(configurationParams);
  }

  async loadWeights(weightsData: unknown): Promise<void> {
    try {
      this._binding.loadWeights(this._requiredHandle(), weightsData);
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  async unloadWeights(): Promise<boolean> {
    return true;
  }

  async activate(): Promise<void> {
    try {
      this._binding.activate(this._requiredHandle());
      this._setState(state.LISTENING);
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  async pause(): Promise<never> {
    throw new QvacErrorAddonWhisper({
      code: ERR_CODES.FAILED_TO_PAUSE,
      adds: "pause is not supported in runJob mode",
    });
  }

  async stop(): Promise<never> {
    throw new QvacErrorAddonWhisper({
      code: ERR_CODES.FAILED_TO_RESET,
      adds: "stop is not supported in runJob mode",
    });
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
        await this._binding.cancel(this._requiredHandle());
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
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  async append(data: AudioData): Promise<number> {
    try {
      if (data?.type === END_OF_INPUT) {
        const currentJobId = this._nextJobId;
        const input = this._drainBufferedAudio();
        const previousJobId = this._activeJobId;
        const previousState = this._state;

        let accepted = false;
        try {
          accepted = this._binding.runJob(this._requiredHandle(), {
            type: "audio",
            input,
            audio_format: this._audioFormat,
          });
        } catch (err) {
          this._activeJobId = previousJobId;
          this._setState(previousState);
          throw err;
        }
        if (!accepted) {
          this._activeJobId = previousJobId;
          this._setState(previousState);
          throw new Error(
            "Cannot set new job: a job is already set or being processed",
          );
        }

        this._activeJobId = currentJobId;
        this._nextJobId = nextSafeId(this._nextJobId);
        this._setState(state.PROCESSING);
        return currentJobId;
      }

      if (data?.type === "audio") {
        if (!(data.input instanceof Uint8Array)) {
          throw new Error("Audio input must be Uint8Array");
        }
        if (
          this._bufferedBytes + data.input.byteLength >
          MAX_BUFFERED_BYTES
        ) {
          throw new QvacErrorAddonWhisper({
            code: ERR_CODES.BUFFER_LIMIT_EXCEEDED,
            adds: `${MAX_BUFFERED_BYTES} bytes`,
          });
        }
        this._bufferedAudio.push(data.input);
        this._bufferedBytes += data.input.byteLength;
        return this._nextJobId;
      }

      throw new Error(`Unknown append input type: ${data?.type}`);
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  async status(): Promise<string> {
    try {
      return this._state;
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_GET_STATUS,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  async destroyInstance(): Promise<void> {
    if (this._handle === null) return;

    try {
      try {
        if (this._activeJobId !== null) {
          await this._binding.cancel(this._handle);
        }
      } catch {}
      this._binding.destroyInstance(this._handle);
      this._handle = null;
      this._bufferedAudio = [];
      this._bufferedBytes = 0;
      this._activeJobId = null;
      this._setState(state.IDLE);
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  async runJob(data: AudioData): Promise<boolean> {
    const currentJobId = this._nextJobId;
    const previousJobId = this._activeJobId;
    const previousState = this._state;
    try {
      const accepted = this._binding.runJob(this._requiredHandle(), {
        ...data,
        audio_format: data?.audio_format || this._audioFormat,
      });
      if (!accepted) {
        this._activeJobId = previousJobId;
        this._setState(previousState);
        return false;
      }
      this._activeJobId = currentJobId;
      this._nextJobId = nextSafeId(this._nextJobId);
      this._setState(state.PROCESSING);
      return true;
    } catch (err) {
      this._activeJobId = previousJobId;
      this._setState(previousState);
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  startStreaming(config: StreamingConfig = {}): void {
    try {
      this._activeJobId = this._nextJobId;
      this._nextJobId = nextSafeId(this._nextJobId);
      this._setState(state.PROCESSING);
      this._binding.startStreaming(this._requiredHandle(), {
        ...config,
        jobId: this._activeJobId,
      });
    } catch (err) {
      this._activeJobId = null;
      this._setState(state.LISTENING);
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_START_STREAMING,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  appendStreamingAudio(data: AudioData): void {
    try {
      if (!(data.input instanceof Uint8Array)) {
        throw new Error("Audio input must be Uint8Array");
      }
      this._binding.appendStreamingAudio(this._requiredHandle(), {
        type: "audio",
        input: data.input,
        audio_format: data.audio_format || this._audioFormat,
      });
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_APPEND_STREAMING,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  endStreaming(): void {
    try {
      this._binding.endStreaming(this._requiredHandle());
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_END_STREAMING,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  finishStreaming(): void {
    this._activeJobId = null;
    this._setState(state.LISTENING);
  }

  _drainBufferedAudio(): Uint8Array {
    const input = this._concatBufferedAudio();
    this._bufferedAudio = [];
    this._bufferedBytes = 0;
    return input;
  }

  _concatBufferedAudio(): Uint8Array {
    if (this._bufferedAudio.length === 0) return new Uint8Array();
    if (this._bufferedAudio.length === 1) {
      return this._bufferedAudio[0];
    }
    const totalLength = this._bufferedAudio.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0,
    );
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this._bufferedAudio) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  private _requiredHandle(): NativeHandle {
    if (this._handle === null) throw new Error("Addon instance is destroyed");
    return this._handle;
  }
}
