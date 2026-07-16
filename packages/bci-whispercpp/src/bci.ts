import { QvacErrorAddonBCI, ERR_CODES, errorMessage } from "./lib/error";
import { ADDON_EVENT } from "./lib/constants";
import { checkConfig, type BCIConfigurationParams } from "./configChecker";

const state = Object.freeze({
  LOADING: "loading",
  LISTENING: "listening",
  PROCESSING: "processing",
  IDLE: "idle",
});

export const END_OF_INPUT = "end of job";

// Upper bound on buffered neural-signal bytes between append() calls.
// Neural data is ~1 MB/s at 512ch * 50 Hz * 4 B, so 500 MB ~= 8 minutes of
// signal. The bound matches transcription-whispercpp and protects against
// runaway producers.
export const MAX_BUFFERED_BYTES = 500 * 1024 * 1024;

export function nextSafeId(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

/** Concatenate a list of byte chunks into a single contiguous Uint8Array. */
export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Neural signal job payload handed to the native runner. */
export interface NeuralJob {
  type: "neural";
  input: Uint8Array;
}

/** Data appended to the internal buffer, or an end-of-job marker. */
export interface AppendData {
  type: string;
  input?: Uint8Array;
}

/** Low-level callback invoked once per normalized native event. */
export type BCIJobEventCallback = (
  addon: unknown,
  event: string,
  jobId: number,
  data: unknown,
  error: unknown,
) => void;

/** Callback invoked on every internal state transition. */
export type TransitionCallback = (addon: BCIInterface, newState: string) => void;

/** Raw callback the native addon invokes with un-normalized events. */
export type NativeOutputCallback = (
  addon: unknown,
  event: unknown,
  data: unknown,
  error: unknown,
) => void;

/** Native binding surface used by {@link BCIInterface}. */
export interface BCIBinding {
  createInstance(
    owner: BCIInterface,
    configurationParams: BCIConfigurationParams,
    outputCallback: NativeOutputCallback,
    transitionCb: TransitionCallback | null,
  ): object;
  activate(handle: unknown): void;
  cancel(handle: unknown, jobId?: number): Promise<void>;
  runJob(handle: unknown, input: NeuralJob): boolean;
  destroyInstance(handle: unknown): void;
  reload?(handle: unknown, configurationParams: BCIConfigurationParams): Promise<void>;
  loadWeights(handle: unknown, weightsData: unknown): void;
}

/**
 * Low-level interface between the Bare C++ BCI addon and the JS runtime.
 * Accepts neural signal data (Uint8Array) instead of audio.
 */
export class BCIInterface {
  static readonly END_OF_INPUT = END_OF_INPUT;

  private readonly _binding: BCIBinding;
  private readonly _outputCb: BCIJobEventCallback;
  private readonly _transitionCb: TransitionCallback | null;
  private _nextJobId: number;
  private _activeJobId: number | null;
  private _bufferedSignal: Uint8Array[];
  private _bufferedBytes: number;
  private _state: string;
  private _handle: object | null;

  constructor(
    binding: BCIBinding,
    configurationParams: BCIConfigurationParams,
    outputCb: BCIJobEventCallback,
    transitionCb: TransitionCallback | null = null,
  ) {
    this._binding = binding;
    this._outputCb = outputCb;
    this._transitionCb = transitionCb;
    this._nextJobId = 1;
    this._activeJobId = null;
    this._bufferedSignal = [];
    this._bufferedBytes = 0;
    this._state = state.LOADING;

    checkConfig(configurationParams);
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      this._addonOutputCallback.bind(this),
      transitionCb,
    );
  }

  private _setState(newState: string): void {
    this._state = newState;
    if (this._transitionCb) {
      this._transitionCb(this, newState);
    }
  }

  private _addonOutputCallback(
    addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    const eventName = typeof event === "string" ? event : "";
    const isError = typeof error === "string" && error.length > 0;
    const isStats =
      data !== null &&
      typeof data === "object" &&
      ("totalTime" in data || "tokensPerSecond" in data || "totalWallMs" in data);
    const isTranscriptOutput =
      (Array.isArray(data) && data.length > 0) ||
      (data !== null &&
        typeof data === "object" &&
        typeof (data as { text?: unknown }).text === "string");

    let mappedEvent = eventName;
    if (eventName === ADDON_EVENT.ERROR || isError || eventName.includes("Error")) {
      mappedEvent = ADDON_EVENT.ERROR;
    } else if (
      eventName === ADDON_EVENT.JOB_ENDED ||
      isStats ||
      eventName.includes("RuntimeStats")
    ) {
      mappedEvent = ADDON_EVENT.JOB_ENDED;
    } else if (eventName === ADDON_EVENT.OUTPUT || isTranscriptOutput) {
      mappedEvent = ADDON_EVENT.OUTPUT;
    } else if (Array.isArray(data) && data.length === 0) {
      return;
    }

    const jobId = this._activeJobId;
    if (jobId === null) {
      return;
    }

    if (mappedEvent === ADDON_EVENT.OUTPUT) {
      this._setState(state.PROCESSING);

      if (Array.isArray(data)) {
        const segments = data as { text?: unknown }[];
        if (segments.length > 0 && typeof segments[0]?.text === "string") {
          for (const segment of segments) {
            this._outputCb(addon, ADDON_EVENT.OUTPUT, jobId, [segment], null);
          }
        } else {
          this._outputCb(addon, ADDON_EVENT.OUTPUT, jobId, data, null);
        }
      } else if (
        data !== null &&
        typeof data === "object" &&
        typeof (data as { text?: unknown }).text === "string"
      ) {
        this._outputCb(addon, ADDON_EVENT.OUTPUT, jobId, [data], null);
      } else {
        this._outputCb(addon, ADDON_EVENT.OUTPUT, jobId, data, null);
      }
      return;
    }

    this._outputCb(addon, mappedEvent, jobId, data, isError ? error : null);

    if (mappedEvent === ADDON_EVENT.ERROR || mappedEvent === ADDON_EVENT.JOB_ENDED) {
      this._activeJobId = null;
      this._setState(state.LISTENING);
    }
  }

  async unload(): Promise<void> {
    await this.destroyInstance();
  }

  async load(configurationParams: BCIConfigurationParams): Promise<void> {
    checkConfig(configurationParams);
    await this.destroyInstance();
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      this._addonOutputCallback.bind(this),
      this._transitionCb,
    );
    this._setState(state.LOADING);
  }

  async reload(configurationParams: BCIConfigurationParams): Promise<void> {
    checkConfig(configurationParams);
    await this.cancel();

    if (typeof this._binding.reload === "function") {
      await this._binding.reload(this._handle, configurationParams);
      this._setState(state.LOADING);
      return;
    }

    await this.load(configurationParams);
  }

  loadWeights(weightsData: unknown): Promise<void> {
    try {
      this._binding.loadWeights(this._handle, weightsData);
    } catch (err) {
      return Promise.reject(
        new QvacErrorAddonBCI({
          code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
          adds: errorMessage(err),
          cause: err as Error,
        }),
      );
    }
    return Promise.resolve();
  }

  unloadWeights(): Promise<boolean> {
    return Promise.resolve(true);
  }

  activate(): Promise<void> {
    try {
      this._binding.activate(this._handle);
      this._setState(state.LISTENING);
    } catch (err) {
      return Promise.reject(
        new QvacErrorAddonBCI({
          code: ERR_CODES.FAILED_TO_ACTIVATE,
          adds: errorMessage(err),
          cause: err as Error,
        }),
      );
    }
    return Promise.resolve();
  }

  async cancel(jobId?: number): Promise<void> {
    try {
      await this._binding.cancel(this._handle, jobId);
      this._bufferedSignal = [];
      this._bufferedBytes = 0;
      this._activeJobId = null;
      this._setState(state.LISTENING);
    } catch (err) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  /**
   * Appends neural signal data to the processing buffer.
   * Send { type: 'end of job' } to trigger processing.
   * @returns job ID
   */
  append(data: AppendData): Promise<number> {
    try {
      return Promise.resolve(this._appendSync(data));
    } catch (err) {
      if (err instanceof QvacErrorAddonBCI) return Promise.reject(err);
      return Promise.reject(
        new QvacErrorAddonBCI({
          code: ERR_CODES.FAILED_TO_APPEND,
          adds: errorMessage(err),
          cause: err as Error,
        }),
      );
    }
  }

  private _appendSync(data: AppendData): number {
    if (data.type === END_OF_INPUT) {
      if (this._bufferedSignal.length === 0) {
        throw new QvacErrorAddonBCI({
          code: ERR_CODES.INVALID_NEURAL_INPUT,
          adds: "no neural signal data was appended before end-of-job",
        });
      }
      const currentJobId = this._nextJobId;
      const input = this._concatBufferedSignal();
      const previousState = this._state;
      const previousJobId = this._activeJobId;

      let accepted = false;
      try {
        accepted = this._binding.runJob(this._handle, {
          type: "neural",
          input,
        });
      } catch (err) {
        this._activeJobId = previousJobId;
        this._setState(previousState);
        throw err;
      }
      if (!accepted) {
        this._activeJobId = previousJobId;
        this._setState(previousState);
        throw new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING });
      }

      this._activeJobId = currentJobId;
      this._nextJobId = nextSafeId(this._nextJobId);
      this._bufferedSignal = [];
      this._bufferedBytes = 0;
      this._setState(state.PROCESSING);
      return currentJobId;
    }

    if (data.type === "neural") {
      if (!(data.input instanceof Uint8Array)) {
        throw new QvacErrorAddonBCI({
          code: ERR_CODES.INVALID_NEURAL_INPUT,
          adds: "input must be Uint8Array",
        });
      }
      if (this._bufferedBytes + data.input.byteLength > MAX_BUFFERED_BYTES) {
        throw new QvacErrorAddonBCI({
          code: ERR_CODES.BUFFER_LIMIT_EXCEEDED,
          adds: MAX_BUFFERED_BYTES + " bytes",
        });
      }
      this._bufferedSignal.push(data.input);
      this._bufferedBytes += data.input.byteLength;
      return this._nextJobId;
    }

    throw new Error(`Unknown append input type: ${data.type}`);
  }

  /**
   * Run a single batch job directly with neural signal data.
   */
  runJob(data: { input?: unknown }): Promise<boolean> {
    if (!data || !(data.input instanceof Uint8Array)) {
      return Promise.reject(
        new QvacErrorAddonBCI({
          code: ERR_CODES.INVALID_NEURAL_INPUT,
          adds: "runJob input must be a Uint8Array",
        }),
      );
    }
    if (data.input.byteLength === 0) {
      return Promise.reject(
        new QvacErrorAddonBCI({
          code: ERR_CODES.INVALID_NEURAL_INPUT,
          adds: "runJob input must not be empty",
        }),
      );
    }

    const candidateJobId = this._nextJobId;
    const previousState = this._state;
    const previousJobId = this._activeJobId;
    let accepted = false;
    try {
      accepted = this._binding.runJob(this._handle, {
        type: "neural",
        input: data.input,
      });
    } catch (err) {
      this._activeJobId = previousJobId;
      this._setState(previousState);
      return Promise.reject(
        new QvacErrorAddonBCI({
          code: ERR_CODES.FAILED_TO_START_JOB,
          adds: errorMessage(err),
          cause: err as Error,
        }),
      );
    }

    if (!accepted) {
      this._activeJobId = previousJobId;
      this._setState(previousState);
      return Promise.resolve(false);
    }

    this._activeJobId = candidateJobId;
    this._nextJobId = nextSafeId(this._nextJobId);
    this._setState(state.PROCESSING);
    return Promise.resolve(accepted);
  }

  status(): Promise<string> {
    return Promise.resolve(this._state);
  }

  async destroyInstance(): Promise<void> {
    if (this._handle === null) {
      return;
    }
    try {
      try {
        await this._binding.cancel(this._handle);
      } catch {}
      this._binding.destroyInstance(this._handle);
      this._handle = null;
      this._bufferedSignal = [];
      this._bufferedBytes = 0;
      this._activeJobId = null;
      this._setState(state.IDLE);
    } catch (err) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  private _concatBufferedSignal(): Uint8Array {
    if (this._bufferedSignal.length === 0) {
      return new Uint8Array();
    }
    if (this._bufferedSignal.length === 1) {
      return this._bufferedSignal[0];
    }
    return concatChunks(this._bufferedSignal);
  }
}
