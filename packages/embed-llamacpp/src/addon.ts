/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

export type NumericLike = `${number}`;

export interface GGMLConfig {
  device: "gpu" | "cpu";
  gpu_layers?: NumericLike;
  batch_size?: NumericLike;
  ctx_size?: NumericLike;
  pooling?: "none" | "mean" | "cls" | "last" | "rank";
  attention?: "causal" | "non-causal";
  embd_normalize?: NumericLike;
  flash_attn?: "on" | "off" | "auto";
  "main-gpu"?: NumericLike | "integrated" | "dedicated";
  /** How to split the model across GPUs. 'row' (tensor parallelism) needs split buffers, which no shipped backend provides as of qvac-fabric v10069, so it is degraded to 'layer' at load with a warning. */
  "split-mode"?: "none" | "layer" | "row";
  "tensor-split"?: string;
  verbosity?: NumericLike;
  /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
  openclCacheDir?: string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface AddonConfigurationParams {
  path: string;
  config: GGMLConfig;
  backendsDir?: string;
}

export interface BertJobInput {
  type: "text" | "sequences";
  input?: string | string[];
}

export interface LoadWeightsData {
  filename: string;
  chunk: Uint8Array | null;
  completed: boolean;
}

export interface RuntimeStats {
  total_tokens: number;
  total_time_ms: number;
  tokens_per_second?: number;
  batch_size: number;
  trained_context_size: number;
  context_size: number;
  backendDevice: "cpu" | "gpu";
}

export type AddonOutputCallback = (
  addon: unknown,
  event: string,
  data: unknown,
  error?: Error,
) => void;

export interface BertBinding {
  createInstance(
    owner: BertInterface,
    configurationParams: AddonConfigurationParams,
    outputCallback: AddonOutputCallback,
  ): object;
  activate(handle: unknown): Promise<void> | void;
  runJob(handle: unknown, input: BertJobInput): Promise<boolean>;
  loadWeights(handle: unknown, data: LoadWeightsData): Promise<void>;
  cancel(handle: unknown): Promise<void>;
  destroyInstance(handle: unknown): void;
}

export interface Addon {
  loadWeights(data: LoadWeightsData): Promise<void>;
  activate(): Promise<void>;
  runJob(input: BertJobInput): Promise<boolean>;
  cancel(): Promise<void>;
  unload(): Promise<void>;
}

export type MappedAddonEvent =
  | { type: "JobEnded"; data: unknown; error: null }
  | { type: "Error"; data: unknown; error: unknown }
  | { type: "Output"; data: unknown; error: null };

/**
 * Normalize a raw native event into `Output` / `Error` / `JobEnded`, mapping
 * `backendDevice` from `0/1` to `'cpu'/'gpu'`. Returns `null` for unknown
 * event names (caller logs and skips dispatch).
 */
export function mapAddonEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown,
): MappedAddonEvent | null {
  // RuntimeStats detected structurally (any of the known stats keys).
  const isStatsData =
    rawData !== null &&
    typeof rawData === "object" &&
    ("tokens_per_second" in rawData ||
      "total_tokens" in rawData ||
      "total_time_ms" in rawData ||
      "batch_size" in rawData ||
      "context_size" in rawData);
  if (isStatsData) {
    const stats: Record<string, unknown> = { ...(rawData as Record<string, unknown>) };
    if (stats.backendDevice === 0) {
      stats.backendDevice = "cpu";
    } else if (stats.backendDevice === 1) {
      stats.backendDevice = "gpu";
    }
    return { type: "JobEnded", data: stats, error: null };
  }

  if (typeof rawEvent === "string" && rawEvent.includes("Error")) {
    return { type: "Error", data: rawData, error: rawError };
  }

  if (typeof rawEvent === "string" && rawEvent.includes("Embeddings")) {
    return { type: "Output", data: rawData, error: null };
  }

  return null;
}

/** An interface between the Bare C++ addon and the JS runtime. */
export class BertInterface implements Addon {
  private readonly _binding: BertBinding;
  private _handle: object | null;

  constructor(
    binding: unknown,
    configurationParams: AddonConfigurationParams,
    outputCb: AddonOutputCallback,
  ) {
    this._binding = binding as BertBinding;

    if (!configurationParams.backendsDir) {
      configurationParams.backendsDir = path.join(__dirname, "prebuilds");
    }

    this._handle = this._binding.createInstance(this, configurationParams, outputCb);
  }

  /** Cancel current inference process. Resolves when the job has stopped. */
  async cancel(): Promise<void> {
    if (!this._handle) return;
    await this._binding.cancel(this._handle);
  }

  /**
   * Processes new input.
   *   - `type: 'text'` for a single string input
   *   - `type: 'sequences'` for a string-array input
   * Resolves `true` if the job was accepted, `false` if busy.
   */
  async runJob(data: BertJobInput): Promise<boolean> {
    return this._binding.runJob(this._handle, data);
  }

  async loadWeights(data: LoadWeightsData): Promise<void> {
    return this._binding.loadWeights(this._handle, data);
  }

  /** Activates the model to start processing the queue. */
  async activate(): Promise<void> {
    return this._binding.activate(this._handle);
  }

  /** Stops the addon process and clears resources (including memory). */
  // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous destroyInstance throw surfaces as a rejected promise, matching the pre-migration contract
  async unload(): Promise<void> {
    if (!this._handle) return;
    this._binding.destroyInstance(this._handle);
    this._handle = null;
  }
}
