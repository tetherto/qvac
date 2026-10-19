import type { QvacResponse } from "@qvac/infer-base";
import type { AddonOutputCallback, NumericLike } from "./addon";
import {
  ModelInterface,
  ModelRunner,
  type MappedModelEvent,
  type ModelBinding,
  type ModelConfigurationParams,
  type ModelRunnerArgs,
} from "./modelRunner";

/**
 * Load options for {@link LayaDecisions}. Any other key is rejected at load:
 * pooling, context size, ubatch and parallelism are fixed by Laya's
 * single-pass decision setup, and embedding options do not apply.
 */
export interface LayaConfig {
  /** Required: a missing device fails at load, as in GGMLBert. */
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
  /**
   * CPU threads, at most the device's CPU count (more only slow a pass down
   * and are rejected at load). Unset uses one per physical core; `0` or below
   * uses every logical CPU.
   */
  threads?: NumericLike;
  /**
   * CPU threads for batch processing, which is all of Laya's work. Same limit
   * as `threads`; unset uses `threads`, `0` or below every logical CPU.
   */
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

export type LayaDecisionsArgs = ModelRunnerArgs<LayaConfig>;

export interface LayaBinding extends ModelBinding {
  createLayaInstance(
    owner: LayaInterface,
    configurationParams: { path: string; config: LayaConfig; backendsDir?: string },
    outputCallback: AddonOutputCallback,
  ): object;
  runJob(handle: unknown, input: { type: "text"; input: string }): Promise<boolean>;
}

export type MappedLayaEvent = MappedModelEvent<LayaResponse>;

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
export class LayaInterface extends ModelInterface<LayaConfig, LayaBinding> {
  protected _createInstance(
    configurationParams: ModelConfigurationParams<LayaConfig>,
    outputCb: AddonOutputCallback,
  ): object {
    return this._binding.createLayaInstance(this, configurationParams, outputCb);
  }

  /** Resolves `true` if the job was accepted, `false` if busy. */
  async runJob(requestJson: string): Promise<boolean> {
    return this._binding.runJob(this._handle, { type: "text", input: requestJson });
  }
}

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
export class LayaDecisions extends ModelRunner<
  LayaConfig,
  LayaRequest,
  string,
  LayaResponse,
  LayaInterface
> {
  protected readonly _modelName = "Laya";

  /**
   * Answers a request. `await()` on the response resolves to `[response]`:
   * one {@link LayaResult} for `state`, or one per state for `states`.
   */
  run(request: LayaSingleRequest): Promise<QvacResponse<LayaResult>>;
  run(request: LayaBatchRequest): Promise<QvacResponse<LayaResult[]>>;
  run(request: LayaRequest): Promise<QvacResponse<LayaResponse>>;
  async run(request: LayaRequest): Promise<QvacResponse<LayaResponse>> {
    return this._runRequest(request);
  }

  protected _createAddon(
    binding: unknown,
    configurationParams: ModelConfigurationParams<LayaConfig>,
    outputCb: AddonOutputCallback,
  ): LayaInterface {
    return new LayaInterface(binding, configurationParams, outputCb);
  }

  protected _encodeRequest(request: LayaRequest): string {
    return JSON.stringify(request);
  }

  protected _startJob(addon: LayaInterface, requestJson: string): Promise<boolean> {
    return addon.runJob(requestJson);
  }

  protected _mapEvent(event: unknown, data: unknown, error: unknown): MappedLayaEvent | null {
    return mapLayaEvent(event, data, error);
  }
}
