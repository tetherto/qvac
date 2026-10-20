export type NumericLike = `${number}`;
export interface GGMLConfig {
    device: "gpu" | "cpu";
    gpu_layers?: NumericLike;
    batch_size?: NumericLike;
    ctx_size?: NumericLike;
    /** Main GGML threadpool busy-wait level, from 0 (sleep while idle) to 100 (maximum polling). Defaults to 0. */
    poll?: NumericLike;
    /** Batch GGML threadpool busy-wait level. Defaults to `poll`, or 0 when neither option is set. */
    "poll-batch"?: NumericLike;
    pooling?: "none" | "mean" | "cls" | "last";
    attention?: "causal" | "non-causal";
    embd_normalize?: NumericLike;
    flash_attn?: "on" | "off" | "auto";
    "main-gpu"?: NumericLike | "integrated" | "dedicated";
    /** Comma-separated GPU backend priority list, e.g. 'cuda,vulkan'. Accepted names: cuda, vulkan, metal, opencl, plus auto for no preference. An unrecognised name is rejected; a recognised one with no device present is skipped. Use device 'cpu' to run on CPU. */
    backend?: string;
    /** How to split the model across GPUs: 'none' pins one device, 'layer' distributes layers. 'row' is rejected at load; use 'layer'. */
    "split-mode"?: "none" | "layer";
    "tensor-split"?: string;
    verbosity?: NumericLike;
    /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
    openclCacheDir?: string;
    [key: string]: string | number | boolean | string[] | undefined;
}
export interface AddonConfigurationParams {
    path: string;
    config: GGMLConfig;
    /**
     * Directory holding the ggml compute backend modules, overriding the ones
     * @qvac/fabric ships. Empty (the default) lets fabric load its own, which
     * it locates next to its runtime on every platform.
     */
    backendsDir?: string;
    /**
     * Projection model (mmproj) that lets the model embed images and audio.
     * Empty (the default) loads the model for text only.
     */
    projectionPath?: string;
}
/**
 * Media in a multimodal input: the bytes of an image (jpg, png, bmp, gif, ...)
 * or of wav/mp3/flac audio. Needs `files.projectionModel`.
 */
export interface EmbedMediaPart {
    media: Uint8Array;
}
/** One part of a multimodal input: text, or media. */
export type EmbedInputPart = string | EmbedMediaPart;
/** One input given as ordered parts. It yields one embedding. */
export type EmbedMultimodalInput = EmbedInputPart[];
/** Several inputs, each a string or ordered parts: one embedding per input. */
export interface EmbedBatchInput {
    inputs: Array<string | EmbedMultimodalInput>;
}
/**
 * Input of `GGMLBert.run()`:
 *   - a string: one embedding;
 *   - a string array: one embedding per string;
 *   - an array with at least one media part: one input whose parts go to the
 *     model in order, one embedding;
 *   - `{ inputs }`: one embedding per input.
 */
export type EmbedRunInput = string | string[] | EmbedMultimodalInput | EmbedBatchInput;
/** A multimodal input part as the native addon receives it. */
export type AddonMultimodalPart = {
    type: "text";
    text: string;
} | {
    type: "media";
    data: Uint8Array;
};
export interface BertJobInput {
    type: "text" | "sequences" | "multimodal";
    input?: string | string[] | AddonMultimodalPart[][];
}
/**
 * Maps a `GGMLBert.run()` input to the native job. Inputs without media take
 * the text path (`text` / `sequences`), so they need no projection model.
 */
export declare function toBertJobInput(input: EmbedRunInput): BertJobInput;
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
/**
 * Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole
 * entry for single-file models. Matches the C++ shard-expansion contract
 * in `GGUFShards::expandGGUFIntoShards`.
 */
export declare function pickPrimaryGgufPath(files: string[]): string;
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
     *   - `type: 'multimodal'` for inputs of ordered text and media parts
     * Resolves `true` if the job was accepted, `false` if busy.
     */
    runJob(data: BertJobInput): Promise<boolean>;
    loadWeights(data: LoadWeightsData): Promise<void>;
    /** Activates the model to start processing the queue. */
    activate(): Promise<void>;
    /** Stops the addon process and clears resources (including memory). */
    unload(): Promise<void>;
}
