import { GgmlModel, type GgmlModelOptions, type GgmlRuntimeStats, type RawRgbOptions } from "./ggml-model";
export interface MegaLocOptions extends GgmlModelOptions {
    /** Local F16 or F16 body + Q6_K projection GGUF. Weights are not bundled. */
    modelPath: string;
}
export type ImageEmbeddingOptions = RawRgbOptions;
export type MegaLocRuntimeStats = GgmlRuntimeStats;
/** Produces an 8,448-element, L2-normalized visual place descriptor. */
export declare class MegaLoc extends GgmlModel {
    constructor(options: MegaLocOptions);
    embed(image: Uint8Array, options?: ImageEmbeddingOptions): Promise<Float32Array>;
}
