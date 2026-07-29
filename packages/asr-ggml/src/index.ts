/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import fs = require("bare-fs");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";

import { QvacErrorAddonASRGgml, ERR_CODES } from "./lib/error";
import {
  BackendId as BackendIdEnum,
  type ASRRunOutput,
  type ASRStreamOutput,
  type AudioChunk,
  type AudioInput,
  type BackendInfo,
  type EndOfTurnEvent,
  type InferenceClientState,
  type ParakeetRuntimeStats,
  type RuntimeStats,
  type RuntimeStatsCore,
  type TranscriptionSegment,
  type VadEvent,
  type WhisperRuntimeStats,
} from "./lib/types";
import type {
  ASRGgmlFiles,
  ASRGgmlReloadConfig,
  ASRStreamingOptions,
  AsrDriver,
  DriverContext,
  EngineType,
  StreamingSession,
} from "./engines/types";
import {
  WhisperDriver,
  type VadParams,
  type WhisperConfig,
  type WhisperEngineConfig,
  type WhisperStreamingOptions,
} from "./engines/whisper/driver";
import {
  ParakeetDriver,
  type ParakeetConfig,
  type ParakeetEngineConfig,
  type ParakeetStreamingRunConfig,
} from "./engines/parakeet/driver";

const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46]; // ASCII "GGUF"

type ASRGgmlConfig = WhisperEngineConfig | ParakeetEngineConfig;

interface ASRGgmlOptions {
  files: ASRGgmlFiles;
  /** Engine-scoped configuration; the discriminant is `config.engine`. */
  config?: ASRGgmlConfig;
  /** Convenience alias when `config` is omitted; `config.engine` wins. */
  engine?: EngineType;
  /** Attach runtime stats to the job-end payload (default: true). */
  enableStats?: boolean;
  logger?: QvacLogger.LoggerInterface | null;
  exclusiveRun?: boolean;
}

type ReleasePolicy = "onSettle" | "onReturn";

/**
 * Best-effort engine sniffing from the model file's magic bytes: GGUF →
 * parakeet, anything else → whisper (legacy GGML `.bin`). Docs and the SDK
 * plugins always pass `engine` explicitly; this is a convenience fallback.
 */
function sniffEngine(modelPath: string): EngineType {
  let fd: number | null = null;
  try {
    fd = fs.openSync(modelPath, "r");
    const magic = new Uint8Array(4);
    const bytesRead = fs.readSync(fd, magic, 0, 4, 0);
    const isGguf =
      bytesRead === 4 &&
      GGUF_MAGIC.every((byte, index) => magic[index] === byte);
    return isGguf ? "parakeet" : "whisper";
  } catch (err) {
    throw new QvacErrorAddonASRGgml({
      code: ERR_CODES.INVALID_ENGINE,
      adds: "pass engine or config.engine explicitly",
      cause: err instanceof Error ? err : undefined,
    });
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function isKnownEngine(value: unknown): value is EngineType {
  return value === "whisper" || value === "parakeet";
}

/**
 * Unified multi-engine ASR client for the whisper and parakeet GGML
 * engines. The engine is selected per instance (`config.engine`, `engine`,
 * or model-file sniffing); the public method surface is engine-agnostic
 * while config vocabularies stay engine-scoped.
 */
class ASRGgml {
  static readonly ENGINE_WHISPER = "whisper";
  static readonly ENGINE_PARAKEET = "parakeet";

  static readonly ERR_CODES = ERR_CODES;
  static readonly Error = QvacErrorAddonASRGgml;

  static readonly inferenceManagerConfig = Object.freeze({
    noAdditionalDownload: true,
  });

  static getModelKey(): string {
    return "asr-ggml";
  }

  readonly logger: QvacLogger;
  readonly exclusiveRun: boolean;
  readonly enableStats: boolean;
  readonly state: InferenceClientState;

  private readonly _engineType: EngineType;
  private readonly _driver: AsrDriver;
  private readonly _job: JobHandler;
  private _queueTail: Promise<void>;
  private _openSession: StreamingSession | null;

  constructor(options: ASRGgmlOptions) {
    const {
      files,
      config,
      engine,
      enableStats = true,
      logger = null,
      exclusiveRun = true,
    } = options || {};

    // 1. Model path is required.
    if (!files || typeof files.model !== "string" || files.model.length === 0) {
      throw new QvacErrorAddonASRGgml({
        code: ERR_CODES.MODEL_REQUIRED,
        adds: "files.model is required",
      });
    }

    this.logger = new QvacLogger(
      (logger as QvacLogger.LoggerInterface | undefined) ?? undefined,
    );
    this.exclusiveRun = !!exclusiveRun;
    this.enableStats = enableStats !== false;
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false,
    };
    this._queueTail = Promise.resolve();
    this._openSession = null;

    // 2. Resolve the engine: config.engine ?? engine ?? sniff.
    this._engineType = this._resolveEngine(files, config, engine);

    // 3. Strict file validation for both engines.
    if (!fs.existsSync(files.model)) {
      throw new QvacErrorAddonASRGgml({
        code: ERR_CODES.MODEL_NOT_FOUND,
        adds: files.model,
      });
    }
    if (this._engineType === "whisper") {
      this._validateWhisperVadModel(
        files,
        config as WhisperEngineConfig | undefined,
      );
    }

    // 4. Construct the driver.
    this._job = createJobHandler({
      cancel: () => this._driver.cancelActive(),
    });
    const ctx: DriverContext = {
      logger: this.logger,
      job: this._job,
      enableStats: this.enableStats,
    };
    if (this._engineType === "parakeet") {
      this._driver = new ParakeetDriver(
        ctx,
        files,
        (config as ParakeetEngineConfig) || { engine: "parakeet" },
      );
    } else {
      this._driver = new WhisperDriver(
        ctx,
        files,
        (config as WhisperEngineConfig) || { engine: "whisper" },
      );
    }

    this.logger.debug("ASRGgml constructor called", {
      engine: this._engineType,
      modelPath: files.model,
      config,
    });

    // 5. Constructor-time config validation.
    this._driver.validateConfig();
  }

  getState(): InferenceClientState {
    return this.state;
  }

  getEngineType(): EngineType {
    return this._engineType;
  }

  getBackendInfo(): BackendInfo | null {
    return this._driver.getBackendInfo();
  }

  async load(): Promise<void> {
    if (this.state.destroyed) {
      throw new QvacErrorAddonASRGgml({
        code: ERR_CODES.INSTANCE_DESTROYED,
      });
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info("Reload requested - unloading existing model first");
      await this.unload();
    }
    await this._driver.load();
    this.state.configLoaded = true;
    this.state.weightsLoaded = true;
  }

  async unload(): Promise<void> {
    return await this._enqueue(async () => {
      if (this._job.active) {
        this._job.fail(new Error("Model was unloaded"));
      }
      await this._driver.cancelActive();
      await this._driver.unload();
      this.state.configLoaded = false;
      this.state.weightsLoaded = false;
    }, "onReturn");
  }

  async destroy(): Promise<void> {
    return await this._enqueue(async () => {
      if (this._job.active) {
        this._job.fail(new Error("Model was destroyed"));
      }
      await this._driver.cancelActive();
      await this._driver.unload();
      this.state.configLoaded = false;
      this.state.weightsLoaded = false;
      this.state.destroyed = true;
    }, "onReturn");
  }

  async reload(newConfig: ASRGgmlReloadConfig = {}): Promise<void> {
    return await this._enqueue(
      () => this._driver.reload(newConfig),
      "onReturn",
    );
  }

  async cancel(jobId?: number): Promise<void> {
    await this._driver.cancelActive(jobId);
  }

  async status(): Promise<string> {
    return await this._driver.status();
  }

  pause(): Promise<never> {
    return Promise.reject(
      new QvacErrorAddonASRGgml({
        code: ERR_CODES.NOT_SUPPORTED,
        adds: "pause",
      }),
    );
  }

  unpause(): Promise<never> {
    return Promise.reject(
      new QvacErrorAddonASRGgml({
        code: ERR_CODES.NOT_SUPPORTED,
        adds: "unpause",
      }),
    );
  }

  async run(audio: AudioInput): Promise<QvacResponse<ASRRunOutput>> {
    this._assertNoOpenSession(
      "concurrent run() during an open streaming session",
    );
    const runFn = (): Promise<QvacResponse<ASRRunOutput>> =>
      this._driver.run(this._driver.normalizeAudio(audio));
    if (this.exclusiveRun) {
      return await this._enqueue(runFn, "onSettle");
    }
    return await runFn();
  }

  async runStreaming(
    audio: AudioInput,
    opts: ASRStreamingOptions = {},
  ): Promise<QvacResponse<ASRStreamOutput>> {
    this._assertNoOpenSession(
      "concurrent runStreaming() during an open streaming session",
    );
    const startFn = async (): Promise<QvacResponse<ASRStreamOutput>> => {
      const session = await this._driver.createStreamingSession(
        this._driver.normalizeAudio(audio),
        opts,
      );
      this._openSession = session;
      void session.done.then(() => {
        if (this._openSession === session) this._openSession = null;
      });
      return session.response;
    };
    if (this.exclusiveRun) {
      // The slot is held for session setup only, never for the
      // (potentially minutes-long) session itself.
      return await this._enqueue(startFn, "onReturn");
    }
    return await startFn();
  }

  private _resolveEngine(
    files: ASRGgmlFiles,
    config: ASRGgmlConfig | undefined,
    engine: EngineType | undefined,
  ): EngineType {
    if (config) {
      const configEngine = (config as { engine?: unknown }).engine;
      if (configEngine === undefined) {
        throw new QvacErrorAddonASRGgml({
          code: ERR_CODES.INVALID_ENGINE,
          adds: "config.engine is required when config is provided",
        });
      }
      if (!isKnownEngine(configEngine)) {
        throw new QvacErrorAddonASRGgml({
          code: ERR_CODES.INVALID_ENGINE,
          adds: 'config.engine must be "whisper" or "parakeet"',
        });
      }
      return configEngine;
    }
    if (engine !== undefined) {
      if (!isKnownEngine(engine)) {
        throw new QvacErrorAddonASRGgml({
          code: ERR_CODES.INVALID_ENGINE,
          adds: `${String(engine)} — pass engine or config.engine explicitly`,
        });
      }
      return engine;
    }
    return sniffEngine(files.model);
  }

  private _validateWhisperVadModel(
    files: ASRGgmlFiles,
    config: WhisperEngineConfig | undefined,
  ): void {
    const vadModelPath =
      config?.vadModelPath ||
      files.vadModel ||
      (typeof config?.whisperConfig?.vad_model_path === "string"
        ? config.whisperConfig.vad_model_path
        : null);
    if (vadModelPath && !fs.existsSync(vadModelPath)) {
      this.logger.error("VAD model file not found", { path: vadModelPath });
      throw new QvacErrorAddonASRGgml({
        code: ERR_CODES.VAD_MODEL_NOT_FOUND,
        adds: vadModelPath,
      });
    }
  }

  private _assertNoOpenSession(adds: string): void {
    if (this._openSession) {
      throw new QvacErrorAddonASRGgml({
        code: ERR_CODES.STREAMING_SESSION_ACTIVE,
        adds,
      });
    }
  }

  /**
   * Single serialized queue for run/reload/unload/destroy. `"onReturn"`
   * releases the slot when `fn()` settles; `"onSettle"` requires `fn()` to
   * resolve with a `QvacResponse` and holds the slot until that response
   * settles.
   */
  private async _enqueue<T>(
    fn: () => Promise<T>,
    policy: ReleasePolicy,
  ): Promise<T> {
    const prev = this._queueTail;
    let releaseSlot: () => void = () => {};
    this._queueTail = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    await prev;

    if (policy === "onReturn") {
      try {
        return await fn();
      } finally {
        releaseSlot();
      }
    }

    let result: T;
    try {
      result = await fn();
    } catch (err) {
      releaseSlot();
      throw err;
    }
    void (result as unknown as QvacResponse<unknown>)
      .await()
      .finally(() => {
        releaseSlot();
      })
      .catch(() => {});
    return result;
  }
}

type EngineTypeShape = EngineType;
type ASRGgmlOptionsShape = ASRGgmlOptions;
type ASRGgmlFilesShape = ASRGgmlFiles;
type ASRGgmlConfigShape = ASRGgmlConfig;
type WhisperEngineConfigShape = WhisperEngineConfig;
type ParakeetEngineConfigShape = ParakeetEngineConfig;
type WhisperConfigShape = WhisperConfig;
type ParakeetConfigShape = ParakeetConfig;
type VadParamsShape = VadParams;
type ASRGgmlReloadConfigShape = ASRGgmlReloadConfig;
type ASRStreamingOptionsShape = ASRStreamingOptions;
type WhisperStreamingOptionsShape = WhisperStreamingOptions;
type ParakeetStreamingRunConfigShape = ParakeetStreamingRunConfig;
type TranscriptionSegmentShape = TranscriptionSegment;
type VadEventShape = VadEvent;
type EndOfTurnEventShape = EndOfTurnEvent;
type ASRRunOutputShape = ASRRunOutput;
type ASRStreamOutputShape = ASRStreamOutput;
type AudioChunkShape = AudioChunk;
type AudioInputShape = AudioInput;
type BackendInfoShape = BackendInfo;
type RuntimeStatsCoreShape = RuntimeStatsCore;
type WhisperRuntimeStatsShape = WhisperRuntimeStats;
type ParakeetRuntimeStatsShape = ParakeetRuntimeStats;
type RuntimeStatsShape = RuntimeStats;
type InferenceClientStateShape = InferenceClientState;

// The namespace merge preserves the package's established `export =` API and
// namespace-qualified public types such as `ASRGgml.RuntimeStats`.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace ASRGgml {
  export type EngineType = EngineTypeShape;
  export type ASRGgmlOptions = ASRGgmlOptionsShape;
  export type ASRGgmlFiles = ASRGgmlFilesShape;
  export type ASRGgmlConfig = ASRGgmlConfigShape;
  export type WhisperEngineConfig = WhisperEngineConfigShape;
  export type ParakeetEngineConfig = ParakeetEngineConfigShape;
  export type WhisperConfig = WhisperConfigShape;
  export type ParakeetConfig = ParakeetConfigShape;
  export type VadParams = VadParamsShape;
  export type ASRGgmlReloadConfig = ASRGgmlReloadConfigShape;
  export type ASRStreamingOptions = ASRStreamingOptionsShape;
  export type WhisperStreamingOptions = WhisperStreamingOptionsShape;
  export type ParakeetStreamingRunConfig = ParakeetStreamingRunConfigShape;
  export type TranscriptionSegment = TranscriptionSegmentShape;
  export type VadEvent = VadEventShape;
  export type EndOfTurnEvent = EndOfTurnEventShape;
  export type ASRRunOutput = ASRRunOutputShape;
  export type ASRStreamOutput = ASRStreamOutputShape;
  export type AudioChunk = AudioChunkShape;
  export type AudioInput = AudioInputShape;
  export type BackendInfo = BackendInfoShape;
  export type RuntimeStatsCore = RuntimeStatsCoreShape;
  export type WhisperRuntimeStats = WhisperRuntimeStatsShape;
  export type ParakeetRuntimeStats = ParakeetRuntimeStatsShape;
  export type RuntimeStats = RuntimeStatsShape;
  export type InferenceClientState = InferenceClientStateShape;

  export import BackendId = BackendIdEnum;
}

export = ASRGgml;
