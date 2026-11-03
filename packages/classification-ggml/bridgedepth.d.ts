import type { ImageClassifierLogger } from "./index";
export interface BridgeDepthOptions {
    /** Local F32 GGUF from scripts/convert-bridgedepth.py. Weights are not bundled. */
    modelPath: string;
    /** Exact GGML device name, such as CPU, CUDA0 or Vulkan0. Default: GPU, then CPU. */
    backend?: string;
    threads?: number;
    backendsDir?: string;
    logger?: ImageClassifierLogger;
}
/** Raw RGB dimensions shared by both views. Omit for JPEG/PNG input. */
export interface StereoImageOptions {
    width: number;
    height: number;
    channels: 3;
}
export interface DisparityResult {
    width: number;
    height: number;
    /** Row-major `[height, width]` disparity of the left image, in input pixels. */
    disparity: Float32Array;
}
export interface BridgeDepthRuntimeStats {
    total_time_ms?: number;
    /** CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99. */
    backend_id?: number;
    cpu_fallback_nodes?: number;
    weight_bytes?: number;
}
/** Stereo disparity from a rectified left/right pair (BridgeDepth, ViT-S mono branch). */
export declare class BridgeDepth {
    private readonly options;
    readonly logger: ImageClassifierLogger;
    private addon;
    private readonly job;
    private readonly exclusive;
    private destroyed;
    private stats;
    constructor(options: BridgeDepthOptions);
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
     * Disparity of the left view. Both views are JPEG/PNG, or raw RGB with
     * `options` giving the shared dimensions; they must have the same size.
     */
    infer(left: Uint8Array, right: Uint8Array, options?: StereoImageOptions): Promise<DisparityResult>;
    private onEvent;
    private release;
    unload(): Promise<void>;
    destroy(): Promise<void>;
}
