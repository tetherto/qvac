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
import { AddonEventRouter } from "./lib/addonEvents";
import * as errorModule from "./lib/error";
import type * as Fit from "./lib/fit";
import { assessFit as assessFitImpl } from "./lib/fit";
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
  type EngineType,
} from "./lib/engineIds";
import { buildNativeParams } from "./lib/engineParams";
import type { EngineSetup } from "./lib/engineSetup";
import { pickAudio8VoiceFields } from "./lib/engines/audio8";
import {
  pickParlerDescFields,
  type ParlerJobSource,
} from "./lib/engines/parler";
import {
  ExclusiveResponseQueue,
  resolveExclusiveRunner,
  type ExclusiveRunner,
} from "./lib/exclusiveQueue";
import { resolveJobFields, type JobFields } from "./lib/jobFields";
import { PocketLifecycle } from "./lib/pocketLifecycle";
import { applyReloadableConfig } from "./lib/reload";
import {
  normalizeError,
  normalizeTextStream,
  requireStreamOutputText,
  resolveRunStreamingOptions,
  SentenceStreamer,
  splitSentenceChunks,
  type SentenceStreamResponse,
} from "./lib/sentenceStream";
import {
  resolveDefaultLazySessionLoading,
  resolveEngineSetup,
} from "./lib/setup";
import { assertSentenceStreamingAllowed } from "./lib/streamingSupport";
import type * as PublicTypes from "./lib/types";
import { toVoiceControlsCatalog } from "./lib/voiceControls";
import type {
  InferenceState,
  RunStreamingOptions,
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
  private readonly _exclusiveStreams = new ExclusiveResponseQueue();
  /** Everything resolved from the constructor options; reload rewrites parts of it. */
  private readonly _setup: EngineSetup;
  private readonly _sentenceStream: SentenceStreamer;
  private readonly _events: AddonEventRouter;
  /** The Pocket execution rules, or null for every other engine. */
  private readonly _pocket: PocketLifecycle | null;
  private _lazySessionLoading: boolean;

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
    this._job = createJobHandler({
      cancel: () =>
        this._pocket ? this.cancel() : this._optionalAddon()?.cancel(),
    });
    this._runExclusive = resolveExclusiveRunner(this.exclusiveRun);
    this._lazySessionLoading = resolveDefaultLazySessionLoading(
      options.lazySessionLoading,
    );
    this._setup = resolveEngineSetup(options);
    this._sentenceStream = new SentenceStreamer({
      startJob: () => this._job.start() as SentenceStreamResponse,
      dispatchJob: (job) => this._dispatchJob(job),
      endJob: (stats) => this._events.endJob(stats),
      failJob: (error) => this._job.fail(error),
      // Audio8 and MOSS report `tokensPerSecond` as codec frames per second,
      // so the streaming aggregate counts frames too rather than characters.
      countsFrames: () =>
        this._setup.engineType === ENGINE_AUDIO8 ||
        this._setup.engineType === ENGINE_MOSS,
    });
    this._events = new AddonEventRouter({
      job: this._job,
      stream: this._sentenceStream,
      logger: () => this._getLogger(),
      reportStats: () => !!(this.opts as { stats?: boolean }).stats,
    });
    this._pocket =
      this._setup.engineType === ENGINE_POCKET
        ? new PocketLifecycle({
            setup: this._setup,
            state: this.state,
            logger: () => this._getLogger(),
            optionalAddon: () => this._optionalAddon(),
            setAddon: (addon) => {
              this.addon = addon;
            },
            createAddon: (params) => this._spawnAddon(params),
            unloadModel: () => this._unloadModel(),
            activeJob: () => this._job.active,
            failStream: (reason) => this._sentenceStream.fail(reason),
          })
        : null;
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
    await this._pocket?.waitCancel();
    this._pocket?.checkReload();
    if (input?.streamOutput === true && this._setup.engineType !== ENGINE_POCKET) {
      assertSentenceStreamingAllowed(this._setup, "run with streamOutput");
      const text = requireStreamOutputText(input.input);
      const jobFields = resolveJobFields(this._setup, input, "run");
      const { locale, maxChunkScalars } = input;
      return this._startStream(() =>
        this._runStreamOrchestrator(text, { locale, maxChunkScalars }, jobFields),
      );
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
    await this._pocket?.waitCancel();
    this._pocket?.checkReload();
    const normalized =
      options == null || typeof options !== "object" ? {} : options;
    if (this._setup.engineType === ENGINE_POCKET) {
      return this._startStream(() =>
        this._runStreamOrchestrator(
          text,
          normalized,
          resolveJobFields(this._setup, normalized, "runStream"),
        ),
      );
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
    await this._pocket?.waitCancel();
    this._pocket?.checkReload();
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
    return this._startStream(() => {
      this._pocket?.checkRequest();
      return this._sentenceStream.streamText(normalized, jobFields);
    });
  }

  /** Streams line up behind each other under `exclusiveRun`; otherwise they start at once. */
  private _startStream(
    run: () => SentenceStreamResponse,
  ): SentenceStreamResponse | Promise<SentenceStreamResponse> {
    return this.exclusiveRun ? this._exclusiveStreams.enqueue(run) : run();
  }

  private _runStreamOrchestrator(
    text: string,
    options: SentenceStreamOptions,
    jobFields?: JobFields,
  ): SentenceStreamResponse {
    this._pocket?.checkRequest();
    const chunks = splitSentenceChunks(
      text,
      options,
      this._setup.config.language,
    );
    this._pocket?.checkRequest();
    return this._sentenceStream.streamChunks(chunks, jobFields);
  }

  private async _load(): Promise<void> {
    this._getLogger().info(
      "[TTSGgml] Language:",
      this._setup.config.language || "en",
    );
    const addon = this._spawnAddon(this._buildTtsParams());
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

  /** A native instance that reports through this wrapper's output callback. */
  private _spawnAddon(configuration: TTSConfigurationParams): TTSInterface {
    return this._createAddon(configuration, this._addonOutputCallback.bind(this));
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

  private async _withPocketLifecycle(action: () => Promise<void>): Promise<void> {
    return this._pocket ? this._pocket.withLifecycle(action) : action();
  }

  private async _runInternal(
    input: TTSRunInput,
  ): Promise<QvacResponse<TTSOutputChunk>> {
    await this._pocket?.waitCancel();
    this._pocket?.checkRequest();
    const jobFields = resolveJobFields(this._setup, input, "run");
    const signal = input?.signal;
    // Pocket keeps the signal to itself: the abort fails the response with
    // the caller's reason and stops native work behind the completion barrier.
    const pocketSignal =
      this._pocket && signal && !signal.aborted ? signal : undefined;
    const response = this._job.start({
      signal: pocketSignal ? undefined : signal,
    }) as QvacResponse<TTSOutputChunk>;
    if (signal?.aborted) return response;
    if (pocketSignal) this._pocket?.attachAbort(response, pocketSignal);
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

  private _addonOutputCallback(
    _addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    this._pocket?.onNativeEvent(data, error);
    this._events.route(event, data, error);
  }

  private async _dispatchJob(input: TTSJobData): Promise<void> {
    const addon = this._requireAddon();
    if (this._setup.engineType === ENGINE_AUDIO8 && this._sentenceStream.ctx) {
      return addon.runJob({ ...input, streamOutput: true });
    }
    return this._pocket ? this._pocket.runJob(addon, input) : addon.runJob(input);
  }

  async cancel(): Promise<void> {
    if (this._pocket) return this._pocket.cancel();
    const addon = this._optionalAddon();
    if (addon?.cancel) await addon.cancel();
  }

  async reload(
    newConfig: Record<string, unknown> = {},
  ): Promise<void> {
    this._getLogger().debug(
      "Reloading addon with new configuration",
      newConfig,
    );
    if (this._pocket) return this._pocket.reload(newConfig);
    const parameters = applyReloadableConfig(this._setup, newConfig);
    await this.cancel();
    this._sentenceStream.fail("Model was reloaded");
    const existingAddon = this._optionalAddon();
    if (existingAddon) await existingAddon.destroyInstance();
    this.addon = this._spawnAddon(parameters);
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
    return toVoiceControlsCatalog(binding.getVoiceControls());
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
