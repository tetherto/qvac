import QvacLogger = require("@qvac/logging");
import { preprocessImage, padState, DEFAULT_IMAGE_SIZE } from "./addon";
import { QvacErrorAddonVla, ERR_CODES } from "./lib/error";
export { preprocessImage, padState, DEFAULT_IMAGE_SIZE };
export { QvacErrorAddonVla, ERR_CODES };
export interface VlaHparams {
    chunkSize: number;
    actionDim: number;
    maxActionDim: number;
    maxStateDim: number;
    tokenizerMaxLength: number;
    visionImageSize: number;
    /**
     * Number of camera views the model accepts. 2 for SmolVLA, up to 3 for
     * π₀.₅. Optional for back-compat — older addon builds may omit it.
     */
    numCameras?: number;
    /**
     * How the consumer passes the robot state. `'continuous'` (SmolVLA) means
     * the `state` Float32Array is projected by an in-model linear layer;
     * `'discrete'` (π₀.₅) means the state is already tokenized into the
     * language prompt and the `state` buffer is ignored. Optional for
     * back-compat.
     */
    stateInputMode?: "continuous" | "discrete";
    /**
     * How the consumer passes camera images. `'pixels'` (SmolVLA, π₀.₅) means
     * each image is a `3 · w · h` float pixel plane; `'patches'` (GR00T) means
     * each image is already patchified by Gr00tPolicy into a
     * `patches · patch_flat` buffer. Optional for back-compat.
     */
    imageInputMode?: "pixels" | "patches";
    /**
     * Exact per-image buffer length (in floats) required when
     * `imageInputMode === 'patches'`. Optional for back-compat.
     */
    imagePatchElems?: number;
}
export interface VlaRunInput {
    images: Float32Array[];
    imgWidth?: number;
    imgHeight?: number;
    state: Float32Array;
    tokens: Int32Array;
    mask: Uint8Array;
    noise?: Float32Array | null;
}
export interface VlaRunStats {
    vision_ms: number;
    /**
     * SmolVLA-specific legacy alias for `prefill_compute_ms`. Kept for
     * back-compat with consumers written against v0.1.x; will be removed once
     * π₀.₅ ships and consumers migrate to the architecture-neutral names.
     */
    smollm2_compute_ms: number;
    /** Legacy alias for `prefill_total_ms`; see `smollm2_compute_ms`. */
    smollm2_total_ms: number;
    /** Architecture-neutral prefill compute time (ms). */
    prefill_compute_ms: number;
    /** Architecture-neutral prefill total time (ms). */
    prefill_total_ms: number;
    ode_ms: number;
    total_ms: number;
    /** 0 = CPU backend, 1 = GPU backend (Vulkan / Metal / OpenCL). */
    backendDevice: number;
}
export interface VlaRunResult {
    actions: Float32Array;
    stats: VlaRunStats;
}
export interface VlaModelOptions {
    files: {
        model: string[];
    };
    config?: VlaConfig;
    logger?: QvacLogger.LoggerInterface | null;
    opts?: {
        stats?: boolean;
    };
}
export interface QvacResponse {
    await(): Promise<VlaRunResult>;
    cancel(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
}
interface VlaConfig {
    verbosity?: number;
    backendsDir?: string;
    [key: string]: unknown;
}
interface VlaModelState {
    configLoaded: boolean;
    weightsLoaded: boolean;
}
export declare class VlaModel {
    readonly logger: QvacLogger;
    opts: {
        stats?: boolean;
    };
    state: VlaModelState;
    private _files;
    private _config;
    private _job;
    private _run;
    private _handle;
    private _hparams;
    private _backendName;
    private _hasActiveResponse;
    private _nativeLoggerActive;
    private _packageName;
    private _packageVersion;
    private _pending;
    constructor({ files, config, logger, opts, }?: VlaModelOptions);
    private _connectNativeLogger;
    private _onAddonEvent;
    private _releaseNativeLogger;
    load({ backend }?: {
        backend?: "auto" | "cpu";
    }): Promise<void>;
    private _load;
    get hparams(): VlaHparams | null;
    get backendName(): string | null;
    run(input: VlaRunInput): Promise<QvacResponse>;
    private _runInternal;
    pause(): Promise<void>;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    getState(): VlaModelState;
}
export default VlaModel;
