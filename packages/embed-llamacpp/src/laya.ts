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
  resolveBackendsDir,
  type AddonOutputCallback,
  type LoadWeightsData,
  type NumericLike,
} from "./addon";

/**
 * Load options for {@link LayaDecisions}. Any other key is rejected at load:
 * pooling, context size, ubatch and parallelism are fixed by Laya's
 * single-pass decision setup, and embedding options do not apply.
 */
export interface LayaConfig {
  device: "gpu" | "cpu";
  gpu_layers?: NumericLike;
  /**
   * Tokens per forward pass (default 2048). Every sequence (one question over
   * one state) must fit; attention over a pass costs O(batch_size²), so raise
   * it only for longer states.
   */
  batch_size?: NumericLike;
  verbosity?: NumericLike;
  flash_attn?: "on" | "off" | "auto";
  "main-gpu"?: NumericLike | "integrated" | "dedicated";
  "split-mode"?: "none" | "layer";
  "tensor-split"?: string;
  /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
  openclCacheDir?: string;
}

/**
 * A state: text, a structured object, or a conversation (newest turn last).
 * Non-string values are rendered as `json.dumps` would; `null` is rejected.
 */
export type LayaState = string | number | boolean | Record<string, unknown> | unknown[];

/** A criterion is text, or any JSON value (rendered as `json.dumps` would). */
export type LayaCriterion = string | number | boolean | Record<string, unknown> | unknown[];

interface LayaQuestionBase {
  /** The question the model answers about the state; must not be empty. */
  instructions: string | number | boolean | Record<string, unknown> | unknown[];
  /**
   * A permutation of the option indices: slot `s` shows option
   * `option_order[s]`. Answers are still reported in the original order.
   */
  option_order?: number[];
}

/** Pick one label. */
export interface LayaChoiceQuestion extends LayaQuestionBase {
  type: "choice";
  /** Labels, or label → description (`null` or `""` shows the label alone). */
  criteria: Array<string | number | boolean> | Record<string, LayaCriterion | null>;
}

/** Ordinal level, reported as an expected level. */
export interface LayaScoreQuestion extends LayaQuestionBase {
  type: "score";
  /** Level descriptions, lowest first. */
  criteria: LayaCriterion[];
}

/** Probability that a statement holds. */
export interface LayaNoulQuestion extends LayaQuestionBase {
  type: "noul";
  /** Descriptions of the two options; `null` or `""` keeps the default. */
  criteria?: { true?: LayaCriterion | null; false?: LayaCriterion | null } | null;
  /** Option labels shown to the model, default "false" / "true". */
  labels?: { false: string; true: string };
}

export type LayaQuestion = LayaChoiceQuestion | LayaScoreQuestion | LayaNoulQuestion;

interface LayaRequestBase {
  /** Question id → question. */
  questions: Record<string, LayaQuestion>;
  /** Overrides the checkpoint's token budget per sequence. */
  max_len?: number;
  /** Overrides the checkpoint's token budget for the question and options. */
  head_max_len?: number;
}

/** One state: the response is a single {@link LayaResult}. */
export interface LayaSingleRequest extends LayaRequestBase {
  state: LayaState;
}

/** Several states: the response is one {@link LayaResult} per state. */
export interface LayaBatchRequest extends LayaRequestBase {
  states: LayaState[];
}

export type LayaRequest = LayaSingleRequest | LayaBatchRequest;

interface LayaAnswerBase {
  /** Probability of the reported answer. */
  answer_confidence: number;
  /** 1 − normalized entropy of the option distribution. */
  confidence: number;
  action: { act_probability: number };
}

export interface LayaChoiceAnswer extends LayaAnswerBase {
  type: "choice";
  choice: string | number | boolean;
  probabilities: Record<string, number>;
}

export interface LayaScoreAnswer extends LayaAnswerBase {
  type: "score";
  /** Expected level, Σ i·p(i). */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export interface LayaNoulAnswer extends LayaAnswerBase {
  type: "noul";
  /** Probability that the statement holds. */
  noul: number;
}

export type LayaAnswer = LayaChoiceAnswer | LayaScoreAnswer | LayaNoulAnswer;

export interface LayaUsage {
  input_tokens: number;
  output_tokens: number;
  state_tokens: number;
  state_tokens_dropped: number;
  truncated: boolean;
  truncated_questions: string[];
  /** Questions whose options collapsed to fewer distinct ones under the token budget. */
  options?: Record<
    string,
    { total: number; distinct: number; tokens_per_option: number | null }
  >;
}

/** laya's `Agent.predict` result for one state. */
export interface LayaResult {
  model: string;
  answers: Record<string, LayaAnswer>;
  usage: LayaUsage;
}

/** {@link LayaResult} for `state`, one per state for `states`. */
export type LayaResponse = LayaResult | LayaResult[];

export interface LayaDecisionsArgs {
  files: { model: string[] };
  config?: LayaConfig;
  logger?: QvacLogger | Console | null;
  opts?: { stats?: boolean };
}

export interface LayaBinding {
  createLayaInstance(
    owner: LayaInterface,
    configurationParams: { path: string; config: LayaConfig; backendsDir?: string },
    outputCallback: AddonOutputCallback,
  ): object;
  activate(handle: unknown): Promise<void> | void;
  runJob(handle: unknown, input: { type: "text"; input: string }): Promise<boolean>;
  loadWeights(handle: unknown, data: LoadWeightsData): Promise<void>;
  cancel(handle: unknown): Promise<void>;
  destroyInstance(handle: unknown): void;
}

export type MappedLayaEvent =
  | { type: "JobEnded"; data: unknown; error: null }
  | { type: "Error"; data: unknown; error: unknown }
  | { type: "Output"; data: LayaResponse; error: null };

/**
 * Normalize a raw native event of a Laya instance. The output is laya's
 * response JSON, parsed here; `backendDevice` in the stats maps `0/1` to
 * `'cpu'/'gpu'`. Returns `null` for unknown events.
 */
export function mapLayaEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown,
): MappedLayaEvent | null {
  if (typeof rawEvent === "string" && rawEvent.includes("LayaDecisionResult")) {
    return { type: "Output", data: JSON.parse(rawData as string) as LayaResponse, error: null };
  }
  if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
    return { type: "Error", data: rawData, error: rawError };
  }
  if (rawData !== null && typeof rawData === "object" && "forward_passes" in rawData) {
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

/** An interface between the native Laya instance and the JS runtime. */
export class LayaInterface {
  private readonly _binding: LayaBinding;
  private _handle: object | null;

  constructor(
    binding: unknown,
    configurationParams: { path: string; config: LayaConfig; backendsDir?: string },
    outputCb: AddonOutputCallback,
  ) {
    this._binding = binding as LayaBinding;
    if (!configurationParams.backendsDir) {
      configurationParams.backendsDir = resolveBackendsDir();
    }
    this._handle = this._binding.createLayaInstance(this, configurationParams, outputCb);
  }

  async cancel(): Promise<void> {
    if (!this._handle) return;
    await this._binding.cancel(this._handle);
  }

  /** Resolves `true` if the job was accepted, `false` if busy. */
  async runJob(requestJson: string): Promise<boolean> {
    return this._binding.runJob(this._handle, { type: "text", input: requestJson });
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

/**
 * Typed decisions with Laya checkpoints: answers `choice`, `score` and `noul`
 * questions about a state in one forward pass per question.
 *
 * ```js
 * const laya = new LayaDecisions({ files: { model: [path] }, config: { device: 'gpu', gpu_layers: '99' } })
 * await laya.load()
 * const [result] = await (await laya.run({ state, questions })).await()
 * ```
 */
export class LayaDecisions {
  logger: QvacLogger;
  opts: { stats?: boolean };
  state: { configLoaded: boolean };

  private _addon: LayaInterface | null;
  private readonly _files: string[];
  private readonly _config: LayaConfig;
  private readonly _job: JobHandler;
  private readonly _run: RunExclusive;
  private _hasActiveResponse: boolean;

  constructor({ files, config = { device: "gpu" }, logger = null, opts = {} }: LayaDecisionsArgs) {
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
    this.logger.info("Creating Laya instance with configuration:", configurationParams);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
      const binding = require("./binding") as LayaBinding;
      this._addon = new LayaInterface(binding, configurationParams, this._outputCallback.bind(this));
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
    this.logger.info("Laya model loaded");
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
   * Answers a request. `await()` on the response resolves to `[response]`:
   * one {@link LayaResult} for `state`, or one per state for `states`.
   */
  run(request: LayaSingleRequest): Promise<QvacResponse<LayaResult>>;
  run(request: LayaBatchRequest): Promise<QvacResponse<LayaResult[]>>;
  run(request: LayaRequest): Promise<QvacResponse<LayaResponse>>;
  async run(request: LayaRequest): Promise<QvacResponse<LayaResponse>> {
    return this._run(() => this._runInternal(request));
  }

  private async _runInternal(request: LayaRequest): Promise<QvacResponse<LayaResponse>> {
    if (!this._addon) {
      throw new Error("Addon not initialized. Call load() first.");
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE);
    }
    const requestJson = JSON.stringify(request);
    const response = this._job.start() as QvacResponse<LayaResponse>;

    let accepted: boolean;
    try {
      accepted = await this._addon.runJob(requestJson);
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
      this.logger?.warn?.("Laya response rejected:", (err as { message?: unknown })?.message ?? err);
    });
    response.await = () => finalized;
    return response;
  }

  private _outputCallback(_addon: unknown, event: unknown, data: unknown, error: unknown): void {
    let mapped: MappedLayaEvent | null;
    try {
      mapped = mapLayaEvent(event, data, error);
    } catch (parseError) {
      this._job.fail(parseError as Error);
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
