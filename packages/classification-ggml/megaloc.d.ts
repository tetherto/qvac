import type { ImageClassifierLogger } from "./index";
export interface MegaLocOptions {
    /** Local F16 or F16 body + Q6_K projection GGUF. Weights are not bundled. */
    modelPath: string;
    /** Exact GGML device name, such as CPU, CUDA0 or Vulkan0. Default: GPU, then CPU. */
    backend?: string;
    threads?: number;
    backendsDir?: string;
    logger?: ImageClassifierLogger;
}
export interface ImageEmbeddingOptions {
    width: number;
    height: number;
    channels: 3;
}
export interface MegaLocRuntimeStats {
    total_time_ms?: number;
    /** CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99. */
    backend_id?: number;
    cpu_fallback_nodes?: number;
    weight_bytes?: number;
}
/** Produces an 8,448-element, L2-normalized visual place descriptor. */
export declare class MegaLoc {
    private readonly options;
    readonly logger: ImageClassifierLogger;
    private addon;
    private readonly job;
    private readonly exclusive;
    private destroyed;
    private stats;
    constructor(options: MegaLocOptions);
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
    embed(image: Uint8Array, options?: ImageEmbeddingOptions): Promise<Float32Array>;
    private onEvent;
    private release;
    unload(): Promise<void>;
    destroy(): Promise<void>;
}
