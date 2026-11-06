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
   * Upstream slots. Upstream schedules the questions and option-order variants
   * of a request over them; it does not change how many requests run at once.
   */
  parallel?: NumericLike;
  /** Projector GGUF path, for models that take images or audio. */
  mmproj?: string;
  verbosity?: NumericLike;
  openclCacheDir?: string;
}

/** A value the model reads as JSON text when it is not a string. */
export type DecisionPayload = string | number | boolean | Record<string, unknown> | unknown[];

/** One question of upstream's /v1/systemone request. */
export type DecisionEngineQuestion =
  | {
      type: "choice";
      instructions: DecisionPayload;
      /** Option key → description (`null` shows the key alone). */
      criteria: Record<string, DecisionPayload | null>;
    }
  | {
      type: "score";
      instructions: DecisionPayload;
      /** 2 to 10 level descriptions, lowest first. */
      criteria: DecisionPayload[];
    }
  | {
      type: "noul";
      instructions: DecisionPayload;
      criteria?: { true?: DecisionPayload | null; false?: DecisionPayload | null } | null;
    };

/** Upstream's /v1/systemone request for one state. */
export interface DecisionEngineRequest {
  state: DecisionPayload | null;
  questions: Record<string, DecisionEngineQuestion>;
  /** Images (or audio clips, for models that take them) as data URLs. */
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
      /** Expected level, Σ i·p(i). */
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
  /** What a `noul` answer means for this model. */
  noul: "probability" | "expected_rating";
  /** All questions answered in one prompt (clef). */
  joint: boolean;
  shared_prefix: boolean;
  images: boolean;
  audio: boolean;
  score_levels: { min: number; max: number };
  /** Maximum nesting of a value inside the request. */
  max_json_depth: number;
  n_ctx: number;
  model: string;
}

export type DecisionEngineArgs = ModelRunnerArgs<DecisionEngineConfig>;

export interface DecisionEngineBinding extends ModelBinding {
  createDecisionEngineInstance(
    owner: DecisionEngineInterface,
    configurationParams: { path: string; config: DecisionEngineConfig; backendsDir?: string },
    outputCallback: AddonOutputCallback,
  ): object;
  decisionInfo(handle: unknown): string;
  runJob(handle: unknown, input: { type: "text"; input: string }): Promise<boolean>;
}

export type MappedDecisionEngineEvent = MappedModelEvent<DecisionEngineResult>;

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
      data: JSON.parse(rawData as string) as DecisionEngineResult,
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
    return this._binding.createDecisionEngineInstance(this, configurationParams, outputCb);
  }

  /** Resolves `true` if the job was accepted, `false` if busy. */
  async runJob(requestJson: string): Promise<boolean> {
    return this._binding.runJob(this._handle, { type: "text", input: requestJson });
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
 * Upstream llama.cpp decision models (openjev, lev, kev, clef, upstream-format
 * laya, ...) through @qvac/fabric's decision bridge. Requests and results use
 * upstream's /v1/systemone shapes, one state per run. Fabric-format Laya
 * checkpoints use {@link LayaDecisions} instead.
 *
 * ```js
 * const engine = new DecisionEngine({ files: { model: [path] }, config: { device: 'gpu' } })
 * await engine.load()
 * engine.info() // { decision_type: 'openjev', noul: 'probability', ... }
 * const [result] = await (await engine.run({ state, questions })).await()
 * ```
 */
export class DecisionEngine extends ModelRunner<
  DecisionEngineConfig,
  DecisionEngineRequest,
  string,
  DecisionEngineResult,
  DecisionEngineInterface
> {
  protected readonly _modelName = "DecisionEngine";

  /** Answers one state. `await()` on the response resolves to `[result]`. */
  async run(request: DecisionEngineRequest): Promise<QvacResponse<DecisionEngineResult>> {
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

  protected _encodeRequest(request: DecisionEngineRequest): string {
    return JSON.stringify(request);
  }

  protected _startJob(addon: DecisionEngineInterface, requestJson: string): Promise<boolean> {
    return addon.runJob(requestJson);
  }

  protected _mapEvent(event: unknown, data: unknown, error: unknown): MappedDecisionEngineEvent | null {
    return mapDecisionEngineEvent(event, data, error);
  }
}
