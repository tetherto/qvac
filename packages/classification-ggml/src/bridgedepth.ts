import type { StereoDepthJob } from "./addon";
import { GgmlModel, withRawRgb, type GgmlModelOptions, type GgmlRuntimeStats, type RawRgbOptions } from "./ggml-model";

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

function isDisparityResult(value: unknown): value is DisparityResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.width === "number" &&
    typeof result.height === "number" &&
    result.disparity instanceof Float32Array &&
    result.disparity.length === result.width * result.height
  );
}

/** Stereo disparity from a rectified left/right pair (BridgeDepth, ViT-S mono branch). */
export class BridgeDepth extends GgmlModel {
  constructor(options: BridgeDepthOptions) {
    super("BridgeDepth", "bridgedepth", options);
  }

  /**
   * Disparity of the left view. Both views are JPEG/PNG, or raw RGB with
   * `options` giving the shared dimensions; they must have the same size.
   */
  infer(left: Uint8Array, right: Uint8Array, options?: StereoImageOptions): Promise<DisparityResult> {
    const input = withRawRgb<StereoDepthJob>({ type: "stereo", left, right }, options);
    return this.runJob(
      input,
      "BridgeDepth job",
      (collected) => {
        // QvacResponse collects each Output event; the addon emits one
        // `[result]` array per job.
        const outputs = Array.isArray(collected) ? collected : [collected];
        const first: unknown = outputs[0];
        const result: unknown = Array.isArray(first) ? first[0] : first;
        return isDisparityResult(result) ? result : null;
      },
      "BridgeDepth returned an invalid disparity map",
    );
  }
}
