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
 * Load options for {@link DecisionEngine}. Any other key is rejected at
 * creation.
 */
export interface DecisionEngineConfig {
  /** Required. `cpu` keeps every layer on the CPU. */
  device: "gpu" | "cpu";
  gpu_layers?: NumericLike;
  /** Context size; unset fits the model to free device memory. */
  ctx_size?: NumericLike;
  batch_size?: NumericLike;
  ubatch_size?: NumericLike;
  threads?: NumericLike;
  /**
   * Upstream slots, at least 1. A request's questions and option-order
   * variants, and a batch's states, run over them together; the engine still
   * takes one request at a time. Unset, llama-server's default: 4 slots
   * sharing one KV cache. Set, each slot has its own share of the context.
   */
  parallel?: NumericLike;
  /** Projector GGUF path, for models that take images or audio. */
  mmproj?: string;
  /**
   * Largest image a request may carry, in megapixels (50 unless set), read
   * from the file's header before it is decoded. Needs `mmproj`.
   */
  image_max_megapixels?: NumericLike;
  /** Longest audio a request may carry, in seconds (600 unless set). Needs `mmproj`. */
  audio_max_seconds?: NumericLike;
  verbosity?: NumericLike;
  openclCacheDir?: string;
}

/** A value the model reads as JSON text when it is not a string. */
export type DecisionPayload = string | number | boolean | Record<string, unknown> | unknown[];

/**
 * A question's instructions. Most models require them. vllm-d3 and
 * h2o-lightning may go without (their prompts have a default), and
 * openbmb-minicpm-ocr-jev must not get any: its prompt carries its one fixed
 * question. Upstream rejects a question that does not fit the loaded model
 * with {@link DECISION_INVALID_REQUEST}.
 */
export type DecisionInstructions = DecisionPayload | null;

/** One question of upstream's /v1/systemone request. */
export type DecisionEngineQuestion =
  | {
      type: "choice";
      instructions?: DecisionInstructions;
      /** Option key → description (`null` shows the key alone). */
      criteria: Record<string, DecisionPayload | null>;
    }
  | {
      type: "score";
      instructions?: DecisionInstructions;
      /**
       * Level descriptions, lowest first: as many as the model's
       * {@link DecisionEngineInfo.score_levels} allow.
       */
      criteria: DecisionPayload[];
    }
  | {
      type: "noul";
      instructions?: DecisionInstructions;
      criteria?: { true?: DecisionPayload | null; false?: DecisionPayload | null } | null;
    };

/** Upstream's /v1/systemone request for one state. */
export interface DecisionEngineRequest {
  state: DecisionPayload | null;
  questions: Record<string, DecisionEngineQuestion>;
  /** Images (or audio clips, for models that take them) as data URLs. */
  files?: string[];
}

/**
 * Several states with the same questions, answered in one run. The states go
 * to upstream concurrently, so its slots (`parallel`) batch them.
 */
export interface DecisionEngineBatchRequest {
  states: Array<DecisionPayload | null>;
  questions: Record<string, DecisionEngineQuestion>;
  /** Images (or audio clips) as data URLs, sent with every state. */
  files?: string[];
}

export type DecisionEngineAnswer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      /**
       * The expected level, Σ i·p(i), or for lfm3-d1 and lfm3-d1-omni the
       * median level (see {@link DecisionEngineInfo.score}).
       */
      score: number;
      /** Level index → description: raw JSON values unless the model canonicalizes them. */
      legend: Record<string, unknown>;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "noul";
      /**
       * Probability of "true" for most models; for lev, the expected rating
       * normalized to 0..1 (see {@link DecisionEngineInfo.noul}).
       */
      noul: number;
    };

/** Upstream's /v1/systemone response for one state. */
export interface DecisionEngineResult {
  model: string;
  answers: Record<string, DecisionEngineAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** The loaded model's decision capabilities. */
export interface DecisionEngineInfo {
  /** Upstream decision type, e.g. "openjev", "lev", "laya", "clef". */
  decision_type: string;
  /**
   * What a `noul` answer means for this model: the probability of "true", or
   * lev's expected rating normalized to 0..1. "unknown" for a decision type
   * this addon does not list; treat its `noul` as neither.
   */
  noul: "probability" | "expected_rating" | "unknown";
  /** All questions answered in one prompt (clef). */
  joint: boolean;
  shared_prefix: boolean;
  images: boolean;
  audio: boolean;
  /**
   * The number of levels a score question may have on this model (2 to 10
   * for most, from 1 for h2o-lightning), as upstream's own parser accepts
   * them; `null` when the model takes no score questions
   * (openbmb-minicpm-ocr-jev).
   */
  score_levels: { min: number; max: number } | null;
  /**
   * What a score answer is: the expected level Σ i·p(i), or the median level
   * (the first whose cumulative probability reaches one half: lfm3-d1 and
   * lfm3-d1-omni). `null` when the model takes no score questions.
   */
  score: "expected_level" | "median_level" | null;
  /**
   * Maximum nesting of each value a request carries (a state, the
   * instructions, each criteria entry), counted from where the value starts.
   * Upstream counts its own limit from the prompt input it builds, so it can
   * reject a value a few levels sooner, also with
   * {@link DECISION_INVALID_REQUEST}.
   */
  max_json_depth: number;
  n_ctx: number;
  /**
   * The longest input a request can have, in tokens: a state with one
   * question and its options. For a non-causal model (Laya) it is what one
   * pass reads (`ubatch_size`, which follows `batch_size`, 2048, unless set);
   * a longer one is rejected with {@link DECISION_INVALID_REQUEST}. For a
   * causal model it is each slot's share of the context, but one token, which
   * every question of every state gets even when all slots are busy.
   */
  max_input_tokens: number;
  model: string;
}

export type DecisionEngineArgs = ModelRunnerArgs<DecisionEngineConfig>;

export interface DecisionEngineBinding extends ModelBinding {
  createInstance(
    owner: DecisionEngineInterface,
    configurationParams: { path: string; config: DecisionEngineConfig; backendsDir?: string },
    outputCallback: AddonOutputCallback,
  ): object;
  decisionInfo(handle: unknown): string;
  /**
   * Admission: the job id (a positive number) under the engine's tagged
   * scheduler, `true` on an untagged scheduler, or `false` when a request is
   * already in flight.
   */
  runJob(handle: unknown, input: { type: "text"; input: string }): Promise<number | boolean>;
}

export type MappedDecisionEngineEvent = MappedModelEvent<
  DecisionEngineResult | DecisionEngineResult[]
>;

/**
 * `code` of a run error for a request the model rejected (bad JSON, nesting
 * too deep, a limit or control the model does not support). Other run errors
 * are execution failures; a cancelled run fails with "Job cancelled".
 */
export const DECISION_INVALID_REQUEST = "DECISION_INVALID_REQUEST";

const INVALID_REQUEST_MARKER = /^(?:\w+: )?invalid request: /;

// The native error is not always an `Error` instance of this realm, so it is
// matched by shape: a string, or an object with a string `message`.
function decisionRunError(rawError: unknown): unknown {
  const message =
    typeof rawError === "string"
      ? rawError
      : rawError !== null &&
          typeof rawError === "object" &&
          typeof (rawError as { message?: unknown }).message === "string"
        ? (rawError as { message: string }).message
        : null;
  if (message === null || !INVALID_REQUEST_MARKER.test(message)) {
    return rawError;
  }
  const error = new Error(message.replace(INVALID_REQUEST_MARKER, "")) as Error & {
    code: string;
  };
  error.code = DECISION_INVALID_REQUEST;
  return error;
}

/**
 * Normalize a raw native event of a DecisionEngine instance. The output is
 * upstream's response JSON, parsed here. Returns `null` for unknown events.
 */
export function mapDecisionEngineEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown,
): MappedDecisionEngineEvent | null {
  if (typeof rawEvent === "string" && rawEvent.includes("DecisionEngineResult")) {
    return {
      type: "Output",
      data: JSON.parse(rawData as string) as DecisionEngineResult | DecisionEngineResult[],
      error: null,
    };
  }
  if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
    return { type: "Error", data: rawData, error: decisionRunError(rawError) };
  }
  if (rawData !== null && typeof rawData === "object" && "decision_input_tokens" in rawData) {
    return { type: "JobEnded", data: { ...(rawData as Record<string, unknown>) }, error: null };
  }
  return null;
}

/** An interface between the native DecisionEngine instance and the JS runtime. */
export class DecisionEngineInterface extends ModelInterface<
  DecisionEngineConfig,
  DecisionEngineBinding
> {
  protected _createInstance(
    configurationParams: ModelConfigurationParams<DecisionEngineConfig>,
    outputCb: AddonOutputCallback,
  ): object {
    return this._binding.createInstance(this, configurationParams, outputCb);
  }

  /**
   * Resolves `true` if the job was accepted, `false` if busy: a request is
   * rejected, not queued, while another runs.
   */
  async runJob(requestJson: string): Promise<boolean> {
    const admitted = await this._binding.runJob(this._handle, {
      type: "text",
      input: requestJson,
    });
    return typeof admitted === "number" ? admitted > 0 : admitted === true;
  }

  /** The loaded model's capabilities; call after activate(). */
  info(): DecisionEngineInfo {
    if (!this._handle) {
      throw new Error("DecisionEngine is not loaded");
    }
    return JSON.parse(this._binding.decisionInfo(this._handle)) as DecisionEngineInfo;
  }
}

/**
 * Upstream llama.cpp decision models (laya, openjev, lev, kev, clef, ...)
 * through upstream's server-context, run in-process by this addon. Requests
 * and results use upstream's /v1/systemone shapes: one state per request, or
 * `states` for several with the same questions.
 *
 * ```js
 * const engine = new DecisionEngine({ files: { model: [path] }, config: { device: 'gpu' } })
 * await engine.load()
 * engine.info() // { decision_type: 'openjev', noul: 'probability', ... }
 * const [result] = await (await engine.run({ state, questions })).await()
 * const [results] = await (await engine.run({ states, questions })).await()
 * ```
 */
export class DecisionEngine extends ModelRunner<
  DecisionEngineConfig,
  DecisionEngineRequest | DecisionEngineBatchRequest,
  string,
  DecisionEngineResult | DecisionEngineResult[],
  DecisionEngineInterface
> {
  protected readonly _modelName = "DecisionEngine";

  /**
   * Answers one state: `await()` on the response resolves to `[result]`. With
   * `states`, it resolves to `[results]`, one per state in input order; the
   * first failing state fails the run.
   */
  async run(request: DecisionEngineRequest): Promise<QvacResponse<DecisionEngineResult>>;
  async run(request: DecisionEngineBatchRequest): Promise<QvacResponse<DecisionEngineResult[]>>;
  async run(
    request: DecisionEngineRequest | DecisionEngineBatchRequest,
  ): Promise<QvacResponse<DecisionEngineResult | DecisionEngineResult[]>>;
  async run(
    request: DecisionEngineRequest | DecisionEngineBatchRequest,
  ): Promise<QvacResponse<DecisionEngineResult | DecisionEngineResult[]>> {
    return this._runRequest(request);
  }

  /** The loaded model's decision capabilities. Throws before load(). */
  info(): DecisionEngineInfo {
    if (!this._addon) {
      throw new Error("Addon not initialized. Call load() first.");
    }
    return this._addon.info();
  }

  protected _createAddon(
    binding: unknown,
    configurationParams: ModelConfigurationParams<DecisionEngineConfig>,
    outputCb: AddonOutputCallback,
  ): DecisionEngineInterface {
    return new DecisionEngineInterface(binding, configurationParams, outputCb);
  }

  protected _encodeRequest(request: DecisionEngineRequest | DecisionEngineBatchRequest): string {
    return JSON.stringify(request);
  }

  protected _startJob(addon: DecisionEngineInterface, requestJson: string): Promise<boolean> {
    return addon.runJob(requestJson);
  }

  protected _mapEvent(event: unknown, data: unknown, error: unknown): MappedDecisionEngineEvent | null {
    return mapDecisionEngineEvent(event, data, error);
  }
}
