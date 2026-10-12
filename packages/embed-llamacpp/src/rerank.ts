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
  pickPrimaryGgufPath,
  type AddonOutputCallback,
  type LoadWeightsData,
  type NumericLike,
} from "./addon";

/**
 * Load options for {@link Reranker}. Any other key is rejected at load:
 * pooling, context size, ubatch and parallelism are fixed by the scoring
 * setup, and embedding options do not apply.
 */
export interface RerankConfig {
  /** Required: a missing device fails at load, as in GGMLBert. */
  device: "gpu" | "cpu";
  gpu_layers?: NumericLike;
  /**
   * Tokens per forward pass (default 2048). Each document, paired with the
   * query, must fit; documents are packed into as few passes as fit.
   */
  batch_size?: NumericLike;
  verbosity?: NumericLike;
  flash_attn?: "on" | "off" | "auto";
  /** Comma-separated GPU backend priority list, as in GGMLBert. */
  backend?: string;
  /** CPU threads, at most the device's CPU count. Unset uses one per physical core; `0` or below uses every logical CPU. */
  threads?: NumericLike;
  /** CPU threads for batch processing. Same limit as `threads`; unset uses `threads`. */
  "threads-batch"?: NumericLike;
  /** Main GGML threadpool busy-wait level, from 0 (sleep while idle) to 100 (maximum polling). Defaults to 0. */
  poll?: NumericLike;
  /** Batch GGML threadpool busy-wait level. Defaults to `poll`, or 0 when neither option is set. */
  "poll-batch"?: NumericLike;
  "main-gpu"?: NumericLike | "integrated" | "dedicated";
  "split-mode"?: "none" | "layer";
  "tensor-split"?: string;
  /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
  openclCacheDir?: string;
}

export interface RerankRequest {
  query: string;
  documents: string[];
}

/**
 * One relevance score per document, in the order the documents were given.
 * Higher is more relevant. It is the model's raw classifier output (a logit for
 * most rerankers), so compare scores within one model, not across models.
 */
export type RerankScores = number[];

export interface RerankerArgs {
  files: { model: string[] };
  /** Required, with at least `device`. */
  config: RerankConfig;
  logger?: QvacLogger | Console | null;
  opts?: { stats?: boolean };
}

export interface RerankBinding {
  createRerankInstance(
    owner: RerankInterface,
    configurationParams: { path: string; config: RerankConfig; backendsDir?: string },
    outputCallback: AddonOutputCallback,
  ): object;
  activate(handle: unknown): Promise<void> | void;
  runJob(handle: unknown, input: { type: "sequences"; input: string[] }): Promise<boolean>;
  loadWeights(handle: unknown, data: LoadWeightsData): Promise<void>;
  cancel(handle: unknown): Promise<void>;
  destroyInstance(handle: unknown): void;
}

export type MappedRerankEvent =
  | { type: "JobEnded"; data: unknown; error: null }
  | { type: "Error"; data: unknown; error: unknown }
  | { type: "Output"; data: RerankScores; error: null };

/**
 * Normalize a raw native event of a rerank instance. The scores arrive as a
 * Float32Array and are returned as numbers; `backendDevice` in the stats maps
 * `0/1` to `'cpu'/'gpu'`. Returns `null` for unknown events.
 */
export function mapRerankEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown,
): MappedRerankEvent | null {
  if (typeof rawEvent === "string" && rawEvent.includes("RerankScores")) {
    return { type: "Output", data: Array.from(rawData as ArrayLike<number>), error: null };
  }
  if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
    return { type: "Error", data: rawData, error: rawError };
  }
  if (rawData !== null && typeof rawData === "object" && "documents" in rawData) {
    const stats: Record<string, unknown> = { ...(rawData as Record<string, unknown>) };
    if (stats.backendDevice === 0) {
      stats.backendDevice = "cpu";
    } else if (stats.backendDevice === 1) {
      stats.backendDevice = "gpu";
    }
    return { type: "JobEnded", data: stats, error: null };
  }
  return null;
}

/** An interface between the native rerank instance and the JS runtime. */
export class RerankInterface {
  private readonly _binding: RerankBinding;
  private _handle: object | null;

  constructor(
    binding: unknown,
    configurationParams: { path: string; config: RerankConfig; backendsDir?: string },
    outputCb: AddonOutputCallback,
  ) {
    this._binding = binding as RerankBinding;
    // createRerankInstance reads the key unconditionally.
    configurationParams.backendsDir ??= "";
    this._handle = this._binding.createRerankInstance(this, configurationParams, outputCb);
  }

  async cancel(): Promise<void> {
    if (!this._handle) return;
    await this._binding.cancel(this._handle);
  }

  /** Resolves `true` if the job was accepted, `false` if busy. */
  async runJob(query: string, documents: string[]): Promise<boolean> {
    return this._binding.runJob(this._handle, { type: "sequences", input: [query, ...documents] });
  }

  async loadWeights(data: LoadWeightsData): Promise<void> {
    return this._binding.loadWeights(this._handle, data);
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

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;
const RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";

function checkRequest(request: RerankRequest): void {
  if (request === null || typeof request !== "object") {
    throw new TypeError("request must be an object with query and documents");
  }
  if (typeof request.query !== "string") {
    throw new TypeError("request.query must be a string");
  }
  if (!Array.isArray(request.documents)) {
    throw new TypeError("request.documents must be an array of strings");
  }
  for (const [i, document] of request.documents.entries()) {
    if (typeof document !== "string") {
      throw new TypeError(`request.documents[${i}] must be a string`);
    }
  }
}

/**
 * Scores documents by relevance to a query with a reranker (cross-encoder)
 * GGUF, such as bge-reranker, jina-reranker or Qwen3-Reranker.
 *
 * ```js
 * const reranker = new Reranker({ files: { model: [path] }, config: { device: 'gpu', gpu_layers: '99' } })
 * await reranker.load()
 * const [scores] = await (await reranker.run({ query, documents })).await()
 * ```
 */
export class Reranker {
  logger: QvacLogger;
  opts: { stats?: boolean };
  state: { configLoaded: boolean };

  private _addon: RerankInterface | null;
  private readonly _files: string[];
  private readonly _config: RerankConfig;
  private readonly _job: JobHandler;
  private readonly _run: RunExclusive;
  private _hasActiveResponse: boolean;

  constructor({ files, config = {} as RerankConfig, logger = null, opts = {} }: RerankerArgs) {
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
    this._job = createJobHandler({ cancel: () => this._addon?.cancel() });
    this._run = exclusiveRunQueue() as RunExclusive;
    this._addon = null;
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
    const configurationParams = { path: pickPrimaryGgufPath(this._files), config: this._config };
    this.logger.info("Creating rerank instance with configuration:", configurationParams);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
      const binding = require("./binding") as RerankBinding;
      this._addon = new RerankInterface(binding, configurationParams, this._outputCallback.bind(this));
      if (this._files.length > 1) {
        await this._streamShards();
      }
      await this._addon.activate();
    } catch (loadError) {
      try {
        await this._addon?.unload();
      } catch {}
      this._addon = null;
      throw loadError;
    }
    this.logger.info("Rerank model loaded");
  }

  private async _streamShards(): Promise<void> {
    for (const filePath of this._files) {
      const filename = path.basename(filePath);
      for await (const chunk of fs.createReadStream(filePath)) {
        await this._addon!.loadWeights({ filename, chunk, completed: false });
      }
      await this._addon!.loadWeights({ filename, chunk: null, completed: true });
    }
  }

  /**
   * Scores each document against the query. `await()` on the response
   * resolves to `[scores]`, one score per document in the given order.
   */
  async run(request: RerankRequest): Promise<QvacResponse<RerankScores>> {
    checkRequest(request);
    return this._run(() => this._runInternal(request));
  }

  private async _runInternal(request: RerankRequest): Promise<QvacResponse<RerankScores>> {
    if (!this._addon) {
      throw new Error("Addon not initialized. Call load() first.");
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE);
    }
    const response = this._job.start() as QvacResponse<RerankScores>;

    let accepted: boolean;
    try {
      accepted = await this._addon.runJob(request.query, request.documents);
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
      this.logger?.warn?.("Rerank response rejected:", (err as { message?: unknown })?.message ?? err);
    });
    response.await = () => finalized;
    return response;
  }

  private _outputCallback(_addon: unknown, event: unknown, data: unknown, error: unknown): void {
    let mapped: MappedRerankEvent | null;
    try {
      mapped = mapRerankEvent(event, data, error);
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
