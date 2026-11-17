import type { ImageEmbeddingJob } from "./addon";
import { GgmlModel, withRawRgb, type GgmlModelOptions, type GgmlRuntimeStats, type RawRgbOptions } from "./ggml-model";

export interface MegaLocOptions extends GgmlModelOptions {
  /** Local F16 or F16 body + Q6_K projection GGUF. Weights are not bundled. */
  modelPath: string;
}

export type ImageEmbeddingOptions = RawRgbOptions;

export type MegaLocRuntimeStats = GgmlRuntimeStats;

/** Length of the MegaLoc descriptor. */
const DESCRIPTOR_LENGTH = 8448;

/** Produces an 8,448-element, L2-normalized visual place descriptor. */
export class MegaLoc extends GgmlModel {
  constructor(options: MegaLocOptions) {
    super("MegaLoc", "megaloc", options);
  }

  embed(image: Uint8Array, options?: ImageEmbeddingOptions): Promise<Float32Array> {
    const input = withRawRgb<ImageEmbeddingJob>({ type: "embedding", content: image }, options);
    return this.runJob(
      input,
      "MegaLoc embedding job",
      (collected) => {
        const result: unknown = Array.isArray(collected) ? collected[0] : collected;
        return result instanceof Float32Array && result.length === DESCRIPTOR_LENGTH ? result : null;
      },
      "MegaLoc returned an invalid descriptor",
    );
  }
}
