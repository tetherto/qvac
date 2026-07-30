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
export type AddonOutputCallback = (addon: unknown, event: string, data: unknown, error?: Error) => void;
export interface BertBinding {
    createInstance(owner: BertInterface, configurationParams: AddonConfigurationParams, outputCallback: AddonOutputCallback): object;
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
export type MappedAddonEvent = {
    type: "JobEnded";
    data: unknown;
    error: null;
} | {
    type: "Error";
    data: unknown;
    error: unknown;
} | {
    type: "Output";
    data: unknown;
    error: null;
};
/**
 * Normalize a raw native event into `Output` / `Error` / `JobEnded`, mapping
 * `backendDevice` from `0/1` to `'cpu'/'gpu'`. Returns `null` for unknown
 * event names (caller logs and skips dispatch).
 */
export declare function mapAddonEvent(rawEvent: unknown, rawData: unknown, rawError: unknown): MappedAddonEvent | null;
/** An interface between the Bare C++ addon and the JS runtime. */
export declare class BertInterface implements Addon {
    private readonly _binding;
    private _handle;
    constructor(binding: unknown, configurationParams: AddonConfigurationParams, outputCb: AddonOutputCallback);
    /** Cancel current inference process. Resolves when the job has stopped. */
    cancel(): Promise<void>;
    /**
     * Processes new input.
     *   - `type: 'text'` for a single string input
     *   - `type: 'sequences'` for a string-array input
     * Resolves `true` if the job was accepted, `false` if busy.
     */
    runJob(data: BertJobInput): Promise<boolean>;
    loadWeights(data: LoadWeightsData): Promise<void>;
    /** Activates the model to start processing the queue. */
    activate(): Promise<void>;
    /** Stops the addon process and clears resources (including memory). */
    unload(): Promise<void>;
}
