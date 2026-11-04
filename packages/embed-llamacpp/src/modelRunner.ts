/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";
import {
  validateModelPath,
  type AddonOutputCallback,
} from "./addon";

/** A native event normalized by a model's event mapper. */
export type MappedModelEvent<Output> =
  | { type: "JobEnded"; data: unknown; error: null }
  | { type: "Error"; data: unknown; error: unknown }
  | { type: "Output"; data: Output; error: null };

export interface ModelConfigurationParams<Config> {
  path: string;
  config: Config;
  backendsDir?: string;
}

/** The binding calls every native model instance shares. */
export interface ModelBinding {
  activate(handle: unknown): Promise<void> | void;
  cancel(handle: unknown): Promise<void>;
  destroyInstance(handle: unknown): void;
}

/**
 * An interface between one native model instance and the JS runtime. A
 * subclass creates the instance and adds its own `runJob`.
 */
export abstract class ModelInterface<Config, Binding extends ModelBinding> {
  protected readonly _binding: Binding;
  protected _handle: object | null;

  constructor(
    binding: unknown,
    configurationParams: ModelConfigurationParams<Config>,
    outputCb: AddonOutputCallback,
  ) {
    this._binding = binding as Binding;
    // The native create call reads the key unconditionally.
    configurationParams.backendsDir ??= "";
    this._handle = this._createInstance(configurationParams, outputCb);
  }

  /**
   * Creates the native instance this interface owns, through `_binding`.
   * Called from the constructor, so it must not use the subclass's fields.
   */
  protected abstract _createInstance(
    configurationParams: ModelConfigurationParams<Config>,
    outputCb: AddonOutputCallback,
  ): object;

  async cancel(): Promise<void> {
    if (!this._handle) return;
    await this._binding.cancel(this._handle);
  }

  async activate(): Promise<void> {
    return this._binding.activate(this._handle);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous destroyInstance throw surfaces as a rejected promise
  async unload(): Promise<void> {
    if (!this._handle) return;
    this._binding.destroyInstance(this._handle);
    this._handle = null;
  }
}

export interface ModelRunnerArgs<Config> {
  /** One absolute disk path, or only the first shard path. Weight streaming is unsupported. */
  files: { model: [string] };
  /** Required, with at least `device`. */
  config: Config;
  logger?: QvacLogger | Console | null;
  opts?: { stats?: boolean };
}

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;
const RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";

/**
 * The lifecycle a standalone model class shares: load from one disk path,
 * one request at a time, cancel and unload, over its own native instance.
 * A subclass names the model and supplies how the instance is created, how a
 * request becomes the job's input, and how native events map to outputs.
 */
export abstract class ModelRunner<
  Config,
  Request,
  Payload,
  Output,
  Addon extends ModelInterface<Config, ModelBinding>,
> {
  logger: QvacLogger;
  opts: { stats?: boolean };
  state: { configLoaded: boolean };

  protected _addon: Addon | null;
  private readonly _modelPath: string;
  private readonly _config: Config;
  private readonly _job: JobHandler;
  private readonly _run: RunExclusive;
  private _hasActiveResponse: boolean;

  /** Names the model in log messages, e.g. "Laya". */
  protected abstract readonly _modelName: string;

  constructor({ files, config = {} as Config, logger = null, opts = {} }: ModelRunnerArgs<Config>) {
    this._modelPath = validateModelPath(files?.model);
    this._config = config;
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface);
    this.opts = opts;
    this._job = createJobHandler({ cancel: () => this._addon?.cancel() });
    this._run = exclusiveRunQueue() as RunExclusive;
    this._addon = null;
    this._hasActiveResponse = false;
    this.state = { configLoaded: false };
  }

  /** Creates the native instance from the package's binding. */
  protected abstract _createAddon(
    binding: unknown,
    configurationParams: ModelConfigurationParams<Config>,
    outputCb: AddonOutputCallback,
  ): Addon;

  /** Turns a request into the job's input; runs before the job starts. */
  protected abstract _encodeRequest(request: Request): Payload;

  /** Hands the input to the native instance: `true` if accepted. */
  protected abstract _startJob(addon: Addon, payload: Payload): Promise<boolean>;

  /** The package's native binding, resolved lazily from its prebuilds. */
  protected _loadBinding(): unknown {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    return require("./binding") as unknown;
  }

  /** Normalizes a native event; throws on malformed output. */
  protected abstract _mapEvent(
    event: unknown,
    data: unknown,
    error: unknown,
  ): MappedModelEvent<Output> | null;

  async load(): Promise<void> {
    return this._run(async () => {
      if (this.state.configLoaded) return;
      await this._load();
      this.state.configLoaded = true;
    });
  }

  private async _load(): Promise<void> {
    const configurationParams = { path: this._modelPath, config: this._config };
    this.logger.info(`Creating ${this._modelName} instance with configuration:`, configurationParams);
    try {
      const binding = this._loadBinding();
      this._addon = this._createAddon(binding, configurationParams, this._outputCallback.bind(this));
      await this._addon.activate();
    } catch (loadError) {
      try {
        await this._addon?.unload();
      } catch {}
      this._addon = null;
      throw loadError;
    }
    this.logger.info(`${this._modelName} model loaded`);
  }

  /** Runs one request; a subclass's `run()` checks and forwards it here. */
  protected async _runRequest(request: Request): Promise<QvacResponse<Output>> {
    return this._run(() => this._runInternal(request));
  }

  private async _runInternal(request: Request): Promise<QvacResponse<Output>> {
    if (!this._addon) {
      throw new Error("Addon not initialized. Call load() first.");
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE);
    }
    const payload = this._encodeRequest(request);
    const response = this._job.start() as QvacResponse<Output>;

    let accepted: boolean;
    try {
      accepted = await this._startJob(this._addon, payload);
    } catch (error) {
      this._job.fail(error as Error);
      throw error;
    }
    if (!accepted) {
      this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE));
      throw new Error(RUN_BUSY_ERROR_MESSAGE);
    }

    this._hasActiveResponse = true;
    const finalized = response.await().finally(() => {
      this._hasActiveResponse = false;
    });
    finalized.catch((err: unknown) => {
      this.logger?.warn?.(
        `${this._modelName} response rejected:`,
        (err as { message?: unknown })?.message ?? err,
      );
    });
    response.await = () => finalized;
    return response;
  }

  private _outputCallback(_addon: unknown, event: unknown, data: unknown, error: unknown): void {
    let mapped: MappedModelEvent<Output> | null;
    try {
      mapped = this._mapEvent(event, data, error);
    } catch (mapError) {
      this._job.fail(mapError as Error);
      return;
    }
    if (mapped === null) {
      this.logger.warn(`Unhandled addon event: ${String(event)} (data type: ${typeof data})`);
      return;
    }
    if (mapped.type === "Error") {
      this.logger.error("Job failed with error:", mapped.error);
      this._job.fail(mapped.error as Error);
      return;
    }
    if (mapped.type === "JobEnded") {
      this._job.end(this.opts.stats ? mapped.data : null);
      return;
    }
    this._job.output(mapped.data);
  }

  /** Unload the model and clear resources. Fails any in-flight job. */
  async unload(): Promise<void> {
    return this._run(async () => {
      await this.cancel();
      if (this._job.active) {
        this._job.fail(new Error("Model was unloaded"));
      }
      this._hasActiveResponse = false;
      if (this._addon) {
        await this._addon.unload();
        this._addon = null;
      }
      this.state.configLoaded = false;
    });
  }

  /** Cancel the current request. */
  async cancel(): Promise<void> {
    await this._addon?.cancel();
  }

  getState(): { configLoaded: boolean } {
    return this.state;
  }
}
