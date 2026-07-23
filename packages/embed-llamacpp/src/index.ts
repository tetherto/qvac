/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";
import {
  BertInterface,
  mapAddonEvent,
  type Addon,
  type AddonConfigurationParams,
  type BertBinding,
  type BertJobInput,
  type GGMLConfig,
} from "./addon";

export type { GGMLConfig, NumericLike, AddonConfigurationParams, RuntimeStats, Addon } from "./addon";
export { BertInterface } from "./addon";
export type { QvacResponse };

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

const RUN_BUSY_ERROR_MESSAGE =
  "Cannot set new job: a job is already set or being processed";

export interface GGMLBertArgs {
  files: { model: string[] };
  config?: GGMLConfig;
  logger?: QvacLogger | Console | null;
  opts?: { stats?: boolean };
}

/**
 * Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole
 * entry for single-file models. Matches the C++ shard-expansion contract
 * in `GGUFShards::expandGGUFIntoShards`.
 */
export function pickPrimaryGgufPath(files: string[]): string {
  const SHARD_REGEX = /-\d+-of-\d+\.gguf$/;
  return files.find((p) => SHARD_REGEX.test(p)) || files[0];
}

/** BERT client wrapping the native BertInterface for embedding generation. */
export class GGMLBert {
  protected addon: Addon | null;
  logger: QvacLogger;
  opts: { stats?: boolean };
  state: { configLoaded: boolean };

  private readonly _files: string[];
  private readonly _config: GGMLConfig;
  private readonly _job: JobHandler;
  private readonly _run: RunExclusive;
  private _hasActiveResponse: boolean;

  constructor({ files, config = {} as GGMLConfig, logger = null, opts = {} }: GGMLBertArgs) {
    if (!files || !Array.isArray(files.model) || files.model.length === 0) {
      throw new TypeError("files.model must be a non-empty array of absolute paths");
    }
    for (const [i, entry] of files.model.entries()) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new TypeError(`files.model[${i}] must be an absolute path string`);
      }
      if (!path.isAbsolute(entry)) {
        throw new TypeError(`files.model[${i}] must be an absolute path (got: ${entry})`);
      }
    }
    this._files = files.model;
    this._config = config;
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface);
    this.opts = opts;
    // Lazy deref + optional chain: safe before `_load()` and after `unload()`.
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() });
    this._run = exclusiveRunQueue() as RunExclusive;
    this.addon = null;
    this._hasActiveResponse = false;
    this.state = { configLoaded: false };
  }

  async load(): Promise<void> {
    return this._run(async () => {
      if (this.state.configLoaded) return;
      await this._load();
      this.state.configLoaded = true;
    });
  }

  private async _load(): Promise<void> {
    this.logger.info("Starting model load");
    const primaryGgufPath = pickPrimaryGgufPath(this._files);
    const configurationParams: AddonConfigurationParams = {
      path: primaryGgufPath,
      config: this._config,
    };

    this.logger.info("Creating addon with configuration:", configurationParams);

    try {
      this.addon = this._createAddon(configurationParams);
      if (this._files.length > 1) {
        await this._streamShards();
      }
      this.logger.info("Activating addon");
      await this.addon.activate();
    } catch (loadError) {
      // Best-effort cleanup of the partially-initialized addon so a subsequent
      // load() does not leak a zombie native instance.
      try {
        await this.addon?.unload?.();
      } catch {}
      this.addon = null;
      throw loadError;
    }
    this.logger.info("Model load completed successfully");
  }

  private async _streamShards(): Promise<void> {
    for (const filePath of this._files) {
      const filename = path.basename(filePath);
      const stream = fs.createReadStream(filePath);
      for await (const chunk of stream) {
        await this.addon!.loadWeights({ filename, chunk, completed: false });
      }
      await this.addon!.loadWeights({ filename, chunk: null, completed: true });
      this.logger.info(`Streamed weights for ${filename}`);
    }
  }

  async run(input: string | string[]): Promise<QvacResponse> {
    return this._run(() => this._runInternal(input));
  }

  private async _runInternal(text: string | string[]): Promise<QvacResponse> {
    if (!this.addon) {
      throw new Error("Addon not initialized. Call load() first.");
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE);
    }

    this.logger.info("Starting inference embeddings for text:", text);
    // Array input → type: 'sequences' (batched pass); string input → type: 'text'.
    const inputData: BertJobInput = Array.isArray(text)
      ? { type: "sequences", input: text }
      : { type: "text", input: text };

    const response = this._job.start();

    // addon-cpp guarantees no output events until runJob is fully accepted.
    // If runJob throws or returns false, no events will fire for this job.
    let accepted: boolean;
    try {
      accepted = await this.addon.runJob(inputData);
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
      const detail =
        (err && typeof err === "object" && "message" in err && (err as { message?: unknown }).message) ||
        err;
      this.logger?.warn?.("Inference response rejected:", detail);
    });
    response.await = () => finalized;
    return response;
  }

  private _addonOutputCallback(
    _addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    const mapped = mapAddonEvent(event, data, error);
    if (mapped === null) {
      // Reaching here means the native layer added an event shape the JS
      // wrapper does not know about. Warn and skip.
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

    if (mapped.type === "Output") {
      this._job.output(mapped.data);
    }
  }

  private _createAddon(configurationParams: AddonConfigurationParams): BertInterface {
    this.logger.info("Creating Bert interface with configuration:", configurationParams);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as BertBinding;
    return new BertInterface(binding, configurationParams, this._addonOutputCallback.bind(this));
  }

  /**
   * Unload the model and clear resources. Ensures any in-flight job is resolved as failed.
   */
  async unload(): Promise<void> {
    return this._run(async () => {
      await this.cancel();
      if (this._job.active) {
        this._job.fail(new Error("Model was unloaded"));
      }
      this._hasActiveResponse = false;
      if (this.addon) {
        await this.addon.unload();
        // Null the addon reference so post-unload `cancel()` / `run()` calls hit the
        // `if (!this.addon)` guard instead of dereferencing a disposed native handle.
        this.addon = null;
      }
      this.state.configLoaded = false;
    });
  }

  /** Cancel the current task. */
  async cancel(): Promise<void> {
    if (this.addon?.cancel) {
      await this.addon.cancel();
    }
  }

  getState(): { configLoaded: boolean } {
    return this.state;
  }
}

export default GGMLBert;

const cjsExports = GGMLBert as typeof GGMLBert & {
  pickPrimaryGgufPath?: typeof pickPrimaryGgufPath;
  GGMLBert?: typeof GGMLBert;
  BertInterface?: typeof BertInterface;
};
cjsExports.pickPrimaryGgufPath = pickPrimaryGgufPath;
cjsExports.GGMLBert = GGMLBert;
cjsExports.BertInterface = BertInterface;
module.exports = cjsExports;
