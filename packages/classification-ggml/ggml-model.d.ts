import { type ImageEmbeddingJob, type StereoDepthJob } from "./addon";
import type { ImageClassifierLogger } from "./index";
/** Options shared by the GGUF models loaded through the native addon. */
export interface GgmlModelOptions {
    /** Local GGUF weights. Weights are not bundled. */
    modelPath: string;
    /** Exact GGML device name, such as CPU, CUDA0 or Vulkan0. Default: GPU, then CPU. */
    backend?: string;
    threads?: number;
    backendsDir?: string;
    logger?: ImageClassifierLogger;
}
/** Raw RGB dimensions of an input. Omit for JPEG/PNG input. */
export interface RawRgbOptions {
    width: number;
    height: number;
    channels: 3;
}
export interface GgmlRuntimeStats {
    total_time_ms?: number;
    /** CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99. */
    backend_id?: number;
    cpu_fallback_nodes?: number;
    weight_bytes?: number;
}
/**
 * Lifecycle shared by MegaLoc and BridgeDepth: option checks, lazy native load,
 * one job at a time, runtime stats, unload and destroy. A subclass names the
 * model and implements its own inference call on top of `runJob()`.
 */
export declare abstract class GgmlModel {
    private readonly name;
    private readonly modelType;
    readonly logger: ImageClassifierLogger;
    private addon;
    private readonly job;
    private readonly exclusive;
    private destroyed;
    private stats;
    private readonly options;
    /** `name` starts every error message; `modelType` selects the native model. */
    protected constructor(name: string, modelType: "megaloc" | "bridgedepth", options: GgmlModelOptions);
    getState(): {
        configLoaded: boolean;
        destroyed: boolean;
    };
    getRuntimeStats(): {
        total_time_ms?: number;
        /** CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99. */
        backend_id?: number;
        cpu_fallback_nodes?: number;
        weight_bytes?: number;
    };
    load(): Promise<void>;
    /**
     * Runs one job and returns `extract()` of what the addon emitted.
     * `jobName` names the job in the rejection message; `extract` returns null
     * for an output of the wrong shape, which rejects with `invalidMessage`.
     */
    protected runJob<T>(input: ImageEmbeddingJob | StereoDepthJob, jobName: string, extract: (collected: unknown) => T | null, invalidMessage: string): Promise<T>;
    private onEvent;
    private release;
    unload(): Promise<void>;
    destroy(): Promise<void>;
}
/** Copies the raw RGB dimensions onto a job; JPEG/PNG input passes none. */
export declare function withRawRgb<J extends ImageEmbeddingJob | StereoDepthJob>(input: J, options?: RawRgbOptions): J;
