/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { FinetuneOptions, GenerationParams } from "./index";

// Index-matched to the C++ GenerationStopReason enum (SequenceDriver.hpp).
const STOP_REASONS = [
  "none",
  "eos",
  "antiprompt",
  "predictionLimit",
  "sequenceLimit",
  "contextOverflow",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export interface AddonMessage {
  type: "text";
  input: string;
  prefill?: boolean;
  /**
   * Per-call sampling overrides forwarded by `LlmLlamacpp.run()` from
   * `RunOptions.generationParams`. Carried on the `text` message and consumed
   * by the native binding so each `runJob` can use a different temp / top_p /
   * seed / etc. without re-loading the model.
   */
  generationParams?: GenerationParams;
  cacheKey?: string;
  saveCacheToDisk?: boolean;
}

export interface AddonMediaMessage {
  type: "media";
  content: Uint8Array;
}

export type AddonRunJobMessage = AddonMessage | AddonMediaMessage;

/**
 * Discriminated admission result: the native binding only sets `id` when the
 * scheduler minted one, so a job id exists exactly when the job was accepted.
 */
export type AdmissionResult =
  | {
      accepted: true;
      /** Native-assigned job id used to route this request's streamed output. */
      id: number;
    }
  | { accepted: false; id?: never };

export type AddonRunJobResult = AdmissionResult;

export interface AddonBatchRunItem {
  /** Optional caller-supplied id; the native binding auto-assigns one when omitted. */
  id?: string;
  messages: AddonRunJobMessage[];
}

/**
 * Batch admission result. The per-sequence `ids` are reported on both
 * branches (they are assigned while parsing the batch input); the native
 * group id used to route the batch's terminal events exists only when the
 * batch was accepted.
 */
export type AddonBatchRunResult =
  | {
      accepted: true;
      /** Native group id used by the batch handler to route this group's terminal events. */
      id: number;
      ids: string[];
    }
  | { accepted: false; id?: never; ids: string[] };

export interface LoadWeightsData {
  filename: string;
  chunk: Uint8Array | null;
  completed: boolean;
}

export interface AddonConfigurationParams {
  path: string;
  projectionPath: string;
  config: Record<string, unknown>;
}

export type AddonOutputCallback = (
  addon: unknown,
  event: unknown,
  data: unknown,
  error: unknown,
  jobId: unknown,
) => void;

export interface LlamaBinding {
  createInstance(
    owner: LlamaInterface,
    configurationParams: AddonConfigurationParams,
    outputCallback: AddonOutputCallback,
    reserved: null,
  ): object;
  loadWeights(handle: unknown, data: LoadWeightsData): Promise<void> | void;
  activate(handle: unknown): Promise<void> | void;
  activeJobs(handle: unknown): number;
  activeSlots(handle: unknown): number;
  cancel(handle: unknown, savePauseCheckpoint: number): Promise<void> | void;
  cancelJob(handle: unknown, id: number): Promise<void> | void;
  finetune?(handle: unknown, params: FinetuneOptions): Promise<number | false> | number | false;
  runJob(handle: unknown, data: AddonRunJobMessage[]): Promise<AddonRunJobResult>;
  runJob(handle: unknown, data: AddonBatchRunItem[]): Promise<AddonBatchRunResult>;
  destroyInstance(handle: unknown): void;
}

export type MappedAddonEvent = {
  type: string;
  data: unknown;
  error: unknown;
};

/**
 * Normalize a raw native event into `Output` / `Error` / `JobEnded` /
 * `FinetuneProgress`, or `null` to drop it.
 */
export function mapAddonEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown,
): MappedAddonEvent | null {
  const dataRecord =
    rawData !== null && typeof rawData === "object"
      ? (rawData as Record<string, unknown>)
      : null;

  // TPS-shaped runtime stats: a job's terminal snapshot. The one trailing a
  // finetune terminal carries the finetune's own id and routes to its sink.
  if (dataRecord && "TPS" in dataRecord) {
    const stats: Record<string, unknown> = { ...dataRecord };
    if (stats.backendDevice === 0) {
      stats.backendDevice = "cpu";
    } else if (stats.backendDevice === 1) {
      stats.backendDevice = "gpu";
    }
    if (typeof stats.stopReason === "number") {
      stats.stopReason = STOP_REASONS[stats.stopReason] || "none";
    }
    return { type: "JobEnded", data: stats, error: null };
  }

  // Finetune terminal: dispatch JobEnded carrying the finetune payload.
  if (
    dataRecord &&
    dataRecord.op === "finetune" &&
    typeof dataRecord.status === "string"
  ) {
    return { type: "JobEnded", data: rawData, error: null };
  }

  // Per-iteration finetune metrics.
  if (dataRecord && dataRecord.type === "finetune_progress") {
    return { type: "FinetuneProgress", data: rawData, error: null };
  }
  if (
    dataRecord &&
    dataRecord.type === "batch_output" &&
    typeof dataRecord.id === "string"
  ) {
    return { type: "BatchOutput", data: rawData, error: null };
  }
  if (Array.isArray(rawData)) {
    return { type: "BatchResult", data: rawData, error: null };
  }

  // Name-based mapping. LogMsg must be checked before the string-to-Output
  // fallback: `JsLogMsgOutputHandler` delivers the log as a plain string,
  // so without this branch it would be misrouted into the job output.
  let type = rawEvent;
  if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
    type = "Error";
  } else if (typeof rawEvent === "string" && rawEvent.includes("LogMsg")) {
    type = "LogMsg";
  } else if (typeof rawData === "string") {
    type = "Output";
  }
  return { type: type as string, data: rawData, error: rawError };
}

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
export class LlamaInterface {
  private readonly _binding: LlamaBinding;
  private _handle: object | null;

  constructor(
    binding: unknown,
    configurationParams: AddonConfigurationParams,
    outputCb: AddonOutputCallback,
  ) {
    this._binding = binding as LlamaBinding;

    if (!configurationParams.config) {
      configurationParams.config = {};
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, "prebuilds");
    }

    this._handle = this._binding.createInstance(this, configurationParams, outputCb, null);
  }

  loadWeights(weightsData: LoadWeightsData): Promise<void> {
    return Promise.resolve(this._binding.loadWeights(this._handle, weightsData));
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  activate(): Promise<void> {
    return Promise.resolve(this._binding.activate(this._handle));
  }

  /**
   * Active jobs (in-flight + queued) per the native scheduler — the
   * authoritative admission count.
   */
  activeJobs(): number {
    if (!this._handle) return 0;
    return this._binding.activeJobs(this._handle);
  }

  /**
   * Requests occupying or waiting for a continuous-batching slot (active +
   * pending). Capacity is consumed in slots, not jobs: one batch job of N
   * prompts takes up to N of them, so `activeJobs()` alone under-reports a
   * full pool. 0 when no batch scheduler is active (`parallel: 1`), where the
   * job count is the right measure — admission therefore compares the max of
   * the two against `parallel`.
   */
  activeSlots(): number {
    if (!this._handle) return 0;
    return this._binding.activeSlots(this._handle);
  }

  /**
   * Cancel every inference job live at the moment of this call (or pause a
   * running finetune). Snapshot-based: the native binding captures the live
   * job ids synchronously before deferring the cancellation, so a job started
   * after this call is never touched.
   */
  async cancel(savePauseCheckpoint = 1): Promise<void> {
    if (!this._handle) return;
    await this._binding.cancel(this._handle, savePauseCheckpoint);
  }

  /**
   * Cancel a single job by its native-assigned id, leaving other concurrent
   * jobs running. Routes to MultiJobScheduler::cancel(id) -> cancelById(id).
   */
  async cancelJob(id: number): Promise<void> {
    if (!this._handle) return;
    // The native binding treats a missing id as cancel-all; cancelling every
    // job is cancel()'s job, so require an explicit id here.
    if (typeof id !== "number") {
      throw new TypeError(
        "cancelJob(id) requires a numeric job id; use cancel() to cancel all jobs",
      );
    }
    await this._binding.cancelJob(this._handle, id);
  }

  /**
   * Run finetuning when native binding provides support.
   */
  finetune(finetuningParams: FinetuneOptions): Promise<number | false> {
    if (typeof this._binding.finetune !== "function") {
      throw new Error("Finetuning is not exposed by this native binding");
    }
    if (finetuningParams === undefined) {
      throw new Error("Finetuning parameters are required");
    }
    return Promise.resolve(this._binding.finetune(this._handle, finetuningParams));
  }

  /**
   * Run one inference job with an array of message objects, or a batch of
   * jobs with an array of `{id?, messages}` items. The native binding mints
   * the job id (single) / group id (batch) and returns it so concurrent jobs
   * can be routed; a batch result also carries the per-item `ids` assigned
   * to each sequence.
   */
  runJob(data: AddonRunJobMessage[]): Promise<AddonRunJobResult>;
  runJob(data: AddonBatchRunItem[]): Promise<AddonBatchRunResult>;
  runJob(
    data: AddonRunJobMessage[] | AddonBatchRunItem[],
  ): Promise<AddonRunJobResult | AddonBatchRunResult> {
    return Promise.resolve(
      this._binding.runJob(this._handle, data as AddonRunJobMessage[]),
    );
  }

  /**
   * Unload the model and clear resources (including memory).
   */
  unload(): Promise<void> {
    if (!this._handle) return Promise.resolve();
    this._binding.destroyInstance(this._handle);
    this._handle = null;
    return Promise.resolve();
  }
}

module.exports = {
  LlamaInterface,
  mapAddonEvent,
};
