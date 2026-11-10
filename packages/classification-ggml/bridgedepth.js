"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeDepth = void 0;
const ggml_model_1 = require("./ggml-model");
function isDisparityResult(value) {
    if (!value || typeof value !== "object")
        return false;
    const result = value;
    return (typeof result.width === "number" &&
        typeof result.height === "number" &&
        result.disparity instanceof Float32Array &&
        result.disparity.length === result.width * result.height);
}
/** Stereo disparity from a rectified left/right pair (BridgeDepth, ViT-S mono branch). */
class BridgeDepth extends ggml_model_1.GgmlModel {
    constructor(options) {
        super("BridgeDepth", "bridgedepth", options);
    }
    /**
     * Disparity of the left view. Both views are JPEG/PNG, or raw RGB with
     * `options` giving the shared dimensions; they must have the same size.
     */
    infer(left, right, options) {
        const input = (0, ggml_model_1.withRawRgb)({ type: "stereo", left, right }, options);
        return this.runJob(input, "BridgeDepth job", (collected) => {
            // QvacResponse collects each Output event; the addon emits one
            // `[result]` array per job.
            const outputs = Array.isArray(collected) ? collected : [collected];
            const first = outputs[0];
            const result = Array.isArray(first) ? first[0] : first;
            return isDisparityResult(result) ? result : null;
        }, "BridgeDepth returned an invalid disparity map");
    }
}
exports.BridgeDepth = BridgeDepth;
