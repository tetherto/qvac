import { GgmlModel, type GgmlModelOptions, type GgmlRuntimeStats, type RawRgbOptions } from "./ggml-model";
export interface BridgeDepthOptions extends GgmlModelOptions {
    /** Local F32 GGUF from scripts/convert-bridgedepth.py. Weights are not bundled. */
    modelPath: string;
}
/** Raw RGB dimensions shared by both views. Omit for JPEG/PNG input. */
export type StereoImageOptions = RawRgbOptions;
export interface DisparityResult {
    width: number;
    height: number;
    /** Row-major `[height, width]` disparity of the left image, in input pixels. */
    disparity: Float32Array;
}
export type BridgeDepthRuntimeStats = GgmlRuntimeStats;
/** Stereo disparity from a rectified left/right pair (BridgeDepth, ViT-S mono branch). */
export declare class BridgeDepth extends GgmlModel {
    constructor(options: BridgeDepthOptions);
    /**
     * Disparity of the left view. Both views are JPEG/PNG, or raw RGB with
     * `options` giving the shared dimensions; they must have the same size.
     */
    infer(left: Uint8Array, right: Uint8Array, options?: StereoImageOptions): Promise<DisparityResult>;
}
