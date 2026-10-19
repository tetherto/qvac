/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import bareOs = require("bare-os");
import loggingModule = require("@qvac/logging");
import type QvacLoggerType from "@qvac/logging";
import type { LoggerInterface } from "@qvac/logging";
// Published logging releases expose a CJS constructor; the workspace exposes
// an ESM default. Bare require(ESM) returns a namespace without __esModule.
const loggingExport = loggingModule as
  | typeof QvacLoggerType
  | { default: typeof QvacLoggerType };
const QvacLogger = typeof loggingExport === "function" ? loggingExport : loggingExport.default;
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  getApiDefinition as inferGetApiDefinition,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";

import {
  TTSInterface,
  type TTSBinding,
  type TTSJobData,
  type TTSConfigurationParams,
  type TTSOutputCallback,
} from "./tts";
import * as errorModule from "./lib/error";
import type * as Fit from "./lib/fit";
import { assessFit as assessFitImpl } from "./lib/fit";
import { buildPocketParams } from "./lib/pocketConfig";
import { accumulateTextStream } from "./lib/textStreamAccumulator";
import {
  ENGINE_AUDIO8,
  ENGINE_CHATTERBOX,
  ENGINE_COSYVOICE3,
  ENGINE_MOSS,
  ENGINE_MOSS_SFX,
  ENGINE_MOSS_SPEECH,
  ENGINE_PARLER,
  ENGINE_POCKET,
  ENGINE_SUPERTONIC,
  FABRIC_ENGINE_TYPES,
  type EngineType,
} from "./lib/engineIds";
import { buildNativeParams } from "./lib/engineParams";
import type { EngineSetup } from "./lib/engineSetup";
import { pickAudio8VoiceFields } from "./lib/engines/audio8";
import {
  pickParlerDescFields,
  type ParlerJobSource,
} from "./lib/engines/parler";
import { resolveJobFields, type JobFields } from "./lib/jobFields";
import { applyReloadableConfig } from "./lib/reload";
import {
  isAudioOutputEvent,
  isStatsEvent,
  normalizeError,
  normalizeTextStream,
  resolveRunStreamingOptions,
  SentenceStreamer,
  splitSentenceChunks,
  ttsOutputDebugString,
  type SentenceStreamResponse,
} from "./lib/sentenceStream";
import {
  resolveDefaultLazySessionLoading,
  resolveEngineSetup,
} from "./lib/setup";
import { assertSentenceStreamingAllowed } from "./lib/streamingSupport";
import type * as PublicTypes from "./lib/types";
import type {
  InferenceState,
  NativeOutputChunk,
  NativeStats,
  RunStreamingOptions,
  RuntimeStats,
  SentenceStreamChunkMeta,
  SentenceStreamOptions,
  TextStreamInput,
  TTSGgmlOptions,
  TTSOutputChunk,
  TTSRunInput,
  VoiceControlsCatalog,
} from "./lib/types";

const { platform } = bareOs;
const { ERR_CODES, QvacErrorAddonTTSGgml } = errorModule;

type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * GGML-backed TTS via the `tts-cpp` library. Wraps the chatterbox,
 * supertonic, parler, cosyvoice3, audio8 and moss engines behind a single
 * engine-agnostic JavaScript surface. Engine type is auto-detected from
 * `files` or selected explicitly with `engine`.
 *
 * Owns a persistent native engine: model weights and voice-conditioning
 * tensors are loaded once by `load()` and reused by `run()`, `runStream()`,
 * and `runStreaming()`.
 */
class TTSGgml {
  static readonly inferenceManagerConfig = {
    noAdditionalDownload: true,
  };
  static readonly ENGINE_CHATTERBOX = ENGINE_CHATTERBOX;
  static readonly ENGINE_SUPERTONIC = ENGINE_SUPERTONIC;
  static readonly ENGINE_COSYVOICE3 = ENGINE_COSYVOICE3;
  static readonly ENGINE_PARLER = ENGINE_PARLER;
  static readonly ENGINE_AUDIO8 = ENGINE_AUDIO8;
  static readonly ENGINE_MOSS = ENGINE_MOSS;
  static readonly ENGINE_MOSS_SFX = ENGINE_MOSS_SFX;
  static readonly ENGINE_MOSS_SPEECH = ENGINE_MOSS_SPEECH;
  static readonly ENGINE_POCKET = ENGINE_POCKET;

  opts: object;
  exclusiveRun: boolean;
  logger: object;
  state: InferenceState;
  addon: unknown;

  private readonly _job: JobHandler;
  private readonly _runExclusive: ExclusiveRunner;
  /** Everything resolved from the constructor options; reload rewrites parts of it. */
  private readonly _setup: EngineSetup;
  private readonly _sentenceStream: SentenceStreamer;
  private _ttsInferenceQueueWaiter: Promise<void>;
  private _lazySessionLoading: boolean;
  private _pocketJobPending: { promise: Promise<void>; resolve: () => void } | null = null;
  private _pocketCancelPromise: Promise<void> | null = null;
  private _pocketLifecycleInProgress = false;

  constructor(options: TTSGgmlOptions = {}) {
    this.opts = options.opts || {};
    this.exclusiveRun = !!options.exclusiveRun;
    this.logger = new QvacLogger(
      options.logger as LoggerInterface | undefined,
    );
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false,
    };
    this.addon = null;
    this._ttsInferenceQueueWaiter = Promise.resolve();
    this._job = createJobHandler({
      cancel: () =>
        this._setup.engineType === ENGINE_POCKET
          ? this.cancel()
          : this._optionalAddon()?.cancel(),
    });
    this._runExclusive = this.exclusiveRun
      ? exclusiveRunQueue()
      : async function runNow<T>(
          callback: () => Promise<T>,
        ): Promise<T> {
          return callback();
        };
    this._lazySessionLoading = resolveDefaultLazySessionLoading(
      options.lazySessionLoading,
    );
    this._setup = resolveEngineSetup(options);
    this._sentenceStream = new SentenceStreamer({
      startJob: () => this._job.start() as SentenceStreamResponse,
      dispatchJob: (job) => this._dispatchJob(job),
      endJob: (stats) => this._endJobWithStats(stats),
      failJob: (error) => this._job.fail(error),
      countsFrames: () => this._pacesOnFrames(),
    });
  }

  getEngineType(): EngineType {
    return this._setup.engineType;
  }

  getApiDefinition(): string {
    const api = inferGetApiDefinition();
    this._getLogger().debug(
      `Using API definition: ${api} for platform: ${platform()}`,
    );
    return api;
  }

  getState(): InferenceState {
    return this.state;
  }

  async load(..._args: unknown[]): Promise<void> {
    void _args;
    return this._withPocketLifecycle(() => this._loadModel());
  }

  private async _loadModel(): Promise<void> {
    if (this.state.destroyed) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_LOAD,
        adds: "instance was destroyed",
      });
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this._getLogger().info(
        "Reload requested - unloading existing model first",
      );
      await this._unloadModel();
    }
    await this._load();
    this.state.configLoaded = true;
    this.state.weightsLoaded = true;
  }

  /**
   * Run text-to-speech. With `{ streamOutput: true }`, splits `input` into
   * chunks and emits PCM through `response.onUpdate` for each chunk.
   */
  async run(
    input: TTSRunInput & { streamOutput: true },
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  >;
  async run(input: TTSRunInput): Promise<QvacResponse<TTSOutputChunk>>;
  async run(
    input: TTSRunInput,
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    await this._waitPocketCancel();
    this._checkPocketReload();
    if (input?.streamOutput === true && this._setup.engineType !== ENGINE_POCKET) {
      assertSentenceStreamingAllowed(this._setup, "run with streamOutput");
      if (
        typeof input.input !== "string" ||
        input.input.trim().length === 0
      ) {
        throw new QvacErrorAddonTTSGgml({
          code: ERR_CODES.FAILED_TO_APPEND,
          adds:
            "run with streamOutput: non-empty string `input` is required",
        });
      }
      const jobFields = resolveJobFields(this._setup, input, "run");
      const runStream = () =>
        this._runStreamOrchestrator(
          input.input,
          {
            locale: input.locale,
            maxChunkScalars: input.maxChunkScalars,
          },
          jobFields,
        );
      return this.exclusiveRun
        ? this._enqueueExclusiveTtsResponse(runStream)
        : runStream();
    }
    return this._runExclusive(() => this._runInternal(input));
  }

  /**
   * Chunked streaming synthesis. Equivalent to
   * `run({ input: text, streamOutput: true, ...options })`.
   */
  async runStream(
    text: string,
    options: SentenceStreamOptions = {},
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    await this._waitPocketCancel();
    this._checkPocketReload();
    const normalized =
      options == null || typeof options !== "object" ? {} : options;
    if (this._setup.engineType === ENGINE_POCKET) {
      const run = () =>
        this._runStreamOrchestrator(
          text,
          normalized,
          resolveJobFields(this._setup, normalized, "runStream"),
        );
      return this.exclusiveRun ? this._enqueueExclusiveTtsResponse(run) : run();
    }
    return this.run({
      input: text,
      streamOutput: true,
      locale: normalized.locale,
      maxChunkScalars: normalized.maxChunkScalars,
      ...((pickParlerDescFields(normalized) ?? {}) as ParlerJobSource),
      ...(pickAudio8VoiceFields(normalized) ?? {}),
      ...(normalized.instruct === undefined
        ? {}
        : { instruct: normalized.instruct }),
    });
  }

  /**
   * Streaming text in and streaming audio out. Each flushed string is one
   * native job and emits PCM through `response.onUpdate`.
   *
   * For `AsyncIterable` inputs, `accumulateSentences` defaults to `true` so
   * small streamed fragments are coalesced.
   */
  async runStreaming(
    textStream: TextStreamInput,
    options: RunStreamingOptions = {},
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    await this._waitPocketCancel();
    this._checkPocketReload();
    assertSentenceStreamingAllowed(this._setup, "runStreaming");
    const jobFields = resolveJobFields(this._setup, options, "runStreaming");
    const streamOptions = resolveRunStreamingOptions(textStream, options);
    let normalized = normalizeTextStream(textStream);
    if (streamOptions.accumulateSentences) {
      normalized = accumulateTextStream(normalized, {
        sentenceDelimiterPreset:
          streamOptions.sentenceDelimiterPreset,
        maxBufferScalars: streamOptions.maxBufferScalars,
        flushAfterMs: streamOptions.flushAfterMs,
        sentenceDelimiter: streamOptions.sentenceDelimiter,
        language: this._setup.config.language,
      });
    }
    const runStream = () =>
      this._runTextStreamOrchestrator(normalized, jobFields);
    return this.exclusiveRun
      ? this._enqueueExclusiveTtsResponse(runStream)
      : runStream();
  }

  private async _enqueueExclusiveTtsResponse(
    run: () => QvacResponse<
      TTSOutputChunk & SentenceStreamChunkMeta
    >,
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    const previous = this._ttsInferenceQueueWaiter;
    let releaseSlot: () => void = () => {};
    this._ttsInferenceQueueWaiter = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    await previous;
    let response: QvacResponse<
      TTSOutputChunk & SentenceStreamChunkMeta
    >;
    try {
      response = run();
    } catch (error) {
      releaseSlot();
      throw error;
    }
    void response
      .await()
      .finally(releaseSlot)
      .catch(() => {});
    return response;
  }

  private _runTextStreamOrchestrator(
    source: AsyncIterable<string>,
    jobFields?: JobFields,
  ): SentenceStreamResponse {
    this._checkPocketRequest();
    return this._sentenceStream.streamText(source, jobFields);
  }

  private _runStreamOrchestrator(
    text: string,
    options: SentenceStreamOptions,
    jobFields?: JobFields,
  ): SentenceStreamResponse {
    this._checkPocketRequest();
    const chunks = splitSentenceChunks(
      text,
      options,
      this._setup.config.language,
    );
    this._checkPocketRequest();
    return this._sentenceStream.streamChunks(chunks, jobFields);
  }

  /**
   * Audio8 and MOSS report `tokensPerSecond` as codec frames per second, so
   * the streaming aggregate has to count frames too rather than characters.
   */
  private _pacesOnFrames(): boolean {
    return (
      this._setup.engineType === ENGINE_AUDIO8 ||
      this._setup.engineType === ENGINE_MOSS
    );
  }

  private async _load(): Promise<void> {
    this._getLogger().info(
      "[TTSGgml] Language:",
      this._setup.config.language || "en",
    );
    const addon = this._createAddon(
      this._buildTtsParams(),
      this._addonOutputCallback.bind(this),
    );
    this.addon = addon;
    try {
      await addon.activate();
    } catch (error) {
      try {
        await addon.destroyInstance();
      } catch {}
      if (this.addon === addon) this.addon = null;
      throw error;
    }
  }

  private _buildTtsParams(): TTSConfigurationParams {
    return buildNativeParams(this._setup);
  }

  private _createAddon(
    configuration: TTSConfigurationParams,
    outputCallback: TTSOutputCallback,
  ): TTSInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as TTSBinding;
    return new TTSInterface(binding, configuration, outputCallback);
  }

  async unload(): Promise<void> {
    return this._withPocketLifecycle(() => this._unloadModel());
  }

  private async _unloadModel(): Promise<void> {
    await this.cancel();
    this._sentenceStream.fail("Model was unloaded");
    const addon = this._optionalAddon();
    try {
      if (addon) await addon.destroyInstance();
    } finally {
      if (this.addon === addon) {
        this.addon = null;
        this.state.configLoaded = false;
        this.state.weightsLoaded = false;
      }
    }
  }

  async destroy(): Promise<void> {
    return this._withPocketLifecycle(async () => {
      await this._unloadModel();
      this.state.destroyed = true;
    });
  }

  private async _runInternal(
    input: TTSRunInput,
  ): Promise<QvacResponse<TTSOutputChunk>> {
    await this._waitPocketCancel();
    this._checkPocketRequest();
    const jobFields = resolveJobFields(this._setup, input, "run");
    const signal = input?.signal;
    const pocketSignal =
      this._setup.engineType === ENGINE_POCKET && signal && !signal.aborted
        ? signal
        : undefined;
    const response = this._job.start({
      signal: pocketSignal ? undefined : signal,
    }) as QvacResponse<TTSOutputChunk>;
    if (signal?.aborted) return response;
    if (pocketSignal) {
      const onAbort = (): void => {
        if (this._job.active !== response) return;
        const reason: unknown = pocketSignal.reason;
        const error = reason instanceof Error ? reason : new Error(typeof reason === "string" ? `Aborted: ${reason}` : "Aborted");
        // Preserve the caller's reason while stopping native work. Cancellation
        // retains the completion barrier until its terminal callback arrives.
        try { response.failed(error); }
        finally {
          void this.cancel().catch((error: unknown) => this._getLogger().error("Pocket abort cancellation failed", error));
        }
      };
      pocketSignal.addEventListener("abort", onAbort, { once: true });
      const detach = (): void => pocketSignal.removeEventListener("abort", onAbort);
      void response.await().then(detach, detach);
    }
    try {
      await this._dispatchJob({
        type: input.type || "text",
        input: input.input,
        ...(jobFields ?? {}),
      });
    } catch (error) {
      this._job.fail(normalizeError(error));
      throw error;
    }
    return response;
  }

  private _endJobWithStats(stats: RuntimeStats | NativeStats): void {
    if ((this.opts as { stats?: boolean }).stats) this._job.end(stats);
    else this._job.end();
  }

  private _addonOutputCallback(
    _addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    if (this._pocketJobPending && ((typeof error === "string" && error.length > 0) || isStatsEvent(data))) {
      const pending = this._pocketJobPending;
      this._pocketJobPending = null;
      pending.resolve();
    }
    if (typeof error === "string" && error.length > 0) {
      this._handleAddonError(error);
    } else if (isAudioOutputEvent(data)) {
      this._handleAddonOutput(data);
    } else if (isStatsEvent(data)) {
      this._handleAddonStats(data);
    } else {
      this._getLogger().debug(
        `Received TTS event: ${String(event)}`,
      );
    }
  }

  private _handleAddonError(error: string): void {
    this._getLogger().error(`TTS job failed with error: ${error}`);
    this._sentenceStream.rejectActiveChunk(new Error(error));
    this._job.fail(error);
  }

  private _handleAddonOutput(data: NativeOutputChunk): void {
    try {
      this._getLogger().debug(
        `TTS job produced output: ${ttsOutputDebugString(data)}`,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        this._getLogger().debug(
          "TTS job produced output: [data too large]",
        );
      } else {
        throw error;
      }
    }
    this._job.output(
      this._sentenceStream.ctx
        ? this._sentenceStream.enrich(data)
        : data,
    );
  }

  private _handleAddonStats(data: NativeStats): void {
    this._getLogger().info(
      `TTS job completed. Stats: ${JSON.stringify(data)}`,
    );
    if (!this._sentenceStream.onStats(data)) this._endJobWithStats(data);
  }

  private async _waitPocketCancel(): Promise<void> {
    if (this._setup.engineType === ENGINE_POCKET && this._pocketCancelPromise) await this._pocketCancelPromise;
  }

  private async _withPocketLifecycle(action: () => Promise<void>): Promise<void> {
    if (this._setup.engineType !== ENGINE_POCKET) return action();
    await this._waitPocketCancel();
    this._checkPocketReload();
    this._pocketLifecycleInProgress = true;
    try { await action(); }
    finally { this._pocketLifecycleInProgress = false; }
  }

  private _checkPocketReload(): void {
    if (this._pocketLifecycleInProgress) throw new Error("Pocket lifecycle operation is already in progress");
  }

  private _checkPocketRequest(): void {
    if (this._setup.engineType === ENGINE_POCKET) {
      if (this.state.destroyed) throw new Error("Pocket instance was destroyed");
      if (!this.state.weightsLoaded || !this._optionalAddon()) throw new Error("Pocket model is not loaded");
    }
    if (this._setup.engineType === ENGINE_POCKET && (this._job.active || this._pocketJobPending)) {
      throw new Error("Pocket synthesis is already in progress");
    }
    this._checkPocketReload();
  }

  private async _dispatchJob(input: TTSJobData): Promise<void> {
    const addon = this._requireAddon();
    if (this._setup.engineType !== ENGINE_POCKET) return addon.runJob(input);
    if (this._pocketJobPending) throw new Error("Pocket native job is already in progress");
    let resolve = (): void => {};
    const promise = new Promise<void>((done) => { resolve = done; });
    const pending = { promise, resolve };
    this._pocketJobPending = pending;
    try { await addon.runJob(input); }
    catch (error) {
      if (this._pocketJobPending === pending) this._pocketJobPending = null;
      resolve();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    const addon = this._optionalAddon();
    if (this._setup.engineType !== ENGINE_POCKET) {
      if (addon?.cancel) await addon.cancel();
      return;
    }
    if (this._pocketCancelPromise) return this._pocketCancelPromise;
    const pending = this._pocketJobPending;
    this._pocketCancelPromise = (async () => {
      this._sentenceStream.fail("Synthesis cancelled");
      if (addon?.cancel) await addon.cancel();
      // Joining the worker can precede delivery of its terminal callback.
      if (pending) await pending.promise;
    })();
    try { await this._pocketCancelPromise; }
    finally { this._pocketCancelPromise = null; }
  }

  private async _reloadPocket(newConfig: Record<string, unknown>): Promise<void> {
    await this._waitPocketCancel();
    this._checkPocketReload();
    if (this.state.destroyed) throw new Error("Pocket instance was destroyed");
    const pocket = this._setup.pocket;
    if (!pocket) throw new Error("Pocket engine is not configured");
    const options = { ...pocket.options, ...newConfig };
    const config = { ...this._setup.config, ...newConfig };
    const params = buildPocketParams(pocket.files, options, config);
    this._pocketLifecycleInProgress = true;
    let replacement: TTSInterface | null = null;
    try {
      // Drain native work and release its model before allocating another one.
      // Failed activation leaves the instance unloaded with its last good config.
      await this._unloadModel();
      replacement = this._createAddon(params, this._addonOutputCallback.bind(this));
      await replacement.activate();
      this.addon = replacement;
      replacement = null;
      this._setup.pocket = { files: pocket.files, options, params };
      this._setup.config.language = "en";
      this._setup.config.useGPU = false;
      this._setup.outputSampleRate = typeof params.outputSampleRate === "number" ? params.outputSampleRate : null;
      this._setup.config.outputSampleRate = this._setup.outputSampleRate ?? undefined;
      this.state.configLoaded = true;
      this.state.weightsLoaded = true;
    } finally {
      try { if (replacement) await replacement.destroyInstance(); }
      finally { this._pocketLifecycleInProgress = false; }
    }
  }

  async reload(
    newConfig: Record<string, unknown> = {},
  ): Promise<void> {
    this._getLogger().debug(
      "Reloading addon with new configuration",
      newConfig,
    );
    if (this._setup.engineType === ENGINE_POCKET) return this._reloadPocket(newConfig);
    const parameters = applyReloadableConfig(this._setup, newConfig);
    await this.cancel();
    this._sentenceStream.fail("Model was reloaded");
    const existingAddon = this._optionalAddon();
    if (existingAddon) await existingAddon.destroyInstance();
    this.addon = this._createAddon(
      parameters,
      this._addonOutputCallback.bind(this),
    );
    await this._requireAddon().activate();
  }

  static getModelKey(_params?: unknown): string {
    void _params;
    return "tts-ggml";
  }

  /**
   * tts-cpp's canonical emotion / pace vocabulary and each engine's supported
   * subset, read from the native library without loading a model. Engines are
   * keyed by engine type, so tts-cpp's `cosyvoice` appears as `cosyvoice3`;
   * an engine this package does not wrap keeps its tts-cpp name.
   */
  static getVoiceControls(): VoiceControlsCatalog {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as TTSBinding;
    const native = binding.getVoiceControls();
    const engines: VoiceControlsCatalog["engines"] = {};
    for (const [name, controls] of Object.entries(native.engines)) {
      engines[FABRIC_ENGINE_TYPES[name] ?? name] = {
        emotions: [...controls.emotions],
        paces: [...controls.paces],
      };
    }
    return {
      emotions: [...native.emotions],
      paces: [...native.paces],
      engines,
    };
  }

  private _requireAddon(): TTSInterface {
    const addon = this._optionalAddon();
    if (!addon) throw new Error("TTS addon is not loaded");
    return addon;
  }

  private _optionalAddon(): TTSInterface | null {
    return (this.addon as TTSInterface | null | undefined) || null;
  }

  private _getLogger(): QvacLoggerType {
    return this.logger as QvacLoggerType;
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging preserves the established class namespace API.
namespace TTSGgml {
  export import QvacErrorAddonTTSGgml =
    errorModule.QvacErrorAddonTTSGgml;
  export import ERR_CODES = errorModule.ERR_CODES;
  export type TTSGgmlFiles = PublicTypes.TTSGgmlFiles;
  export type TTSGgmlRuntimeConfig = PublicTypes.TTSGgmlRuntimeConfig;
  export type TTSGgmlOptions = PublicTypes.TTSGgmlOptions;
  export type LavaSREnhancerOptions = PublicTypes.LavaSREnhancerOptions;
  export type LavaSRDenoiserOptions = PublicTypes.LavaSRDenoiserOptions;
  export type RuntimeStats = PublicTypes.RuntimeStats;
  export type TTSOutputChunk = PublicTypes.TTSOutputChunk;
  export type SentenceStreamChunkMeta = PublicTypes.SentenceStreamChunkMeta;
  export type SentenceStreamOptions = PublicTypes.SentenceStreamOptions;
  export type RunStreamingOptions = PublicTypes.RunStreamingOptions;
  export type TextStreamInput = PublicTypes.TextStreamInput;
  export type TTSRunInput = PublicTypes.TTSRunInput;
  export type InferenceState = PublicTypes.InferenceState;
  export type CosyvoiceInstruct = PublicTypes.CosyvoiceInstruct;
  export type VoiceControlsCatalog = PublicTypes.VoiceControlsCatalog;

  export type TtsFitEngine = Fit.TtsFitEngine;
  export type TtsFitRequest = Fit.TtsFitRequest;
  export type TtsFitResult = Fit.TtsFitResult;
  export type TtsFitStatus = Fit.TtsFitStatus;
  export type SupertonicFitRequest = Fit.SupertonicFitRequest;
  export type ParlerFitRequest = Fit.ParlerFitRequest;
  export type ChatterboxFitRequest = Fit.ChatterboxFitRequest;
  export type Audio8FitRequest = Fit.Audio8FitRequest;
  export type MossFitRequest = Fit.MossFitRequest;
  export type MossSoundEffectFitRequest = Fit.MossSoundEffectFitRequest;
  export type CosyvoiceFitRequest = Fit.CosyvoiceFitRequest;

  export const assessFit = assessFitImpl;
}

export = TTSGgml;

(module as { exports: typeof TTSGgml }).exports.QvacErrorAddonTTSGgml =
  errorModule.QvacErrorAddonTTSGgml;
(module as { exports: typeof TTSGgml }).exports.ERR_CODES =
  errorModule.ERR_CODES;
