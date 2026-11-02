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
    /** With `files.projectionModel`: largest per-image token budget of a dynamic-resolution vision encoder. Unset keeps the projector's default (1120 for EmbeddingGemma 2). Alias: `image_max_tokens`. */
    "image-max-tokens"?: NumericLike;
    /** With `files.projectionModel`: smallest per-image token budget. Unset keeps the projector's default. Alias: `image_min_tokens`. */
    "image-min-tokens"?: NumericLike;
    /** With `files.projectionModel`: skip loading the audio encoder, for image-only use. Defaults to off (audio loads). Alias: `mmproj_no_audio`. */
    "mmproj-no-audio"?: "true" | "false" | "on" | "off" | "1" | "0";
    /** With `files.projectionModel`: run the projector on the GPU. Unset follows the model, except on Android GPUs below Adreno 800, where it runs on the CPU. Ignored when the model runs on the CPU. Alias: `mmproj_use_gpu`. */
    "mmproj-use-gpu"?: "true" | "false" | "on" | "off" | "1" | "0";
    /** With `files.projectionModel`: largest image accepted, in megapixels, checked before decoding. Defaults to 50. Alias: `image_max_megapixels`. */
    "image-max-megapixels"?: NumericLike;
    /** With `files.projectionModel`: longest audio accepted, in seconds, read from its headers before decoding. Defaults to 600. Alias: `audio_max_seconds`. */
    "audio-max-seconds"?: NumericLike;
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
 *   - `{ inputs }`: one embedding per input, each a string or ordered parts.
 *     Media goes only here, so a bare array always means one embedding per
 *     string.
 */
export type EmbedRunInput = string | string[] | EmbedBatchInput;
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
