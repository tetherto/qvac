"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MegaLoc = void 0;
const ggml_model_1 = require("./ggml-model");
/** Length of the MegaLoc descriptor. */
const DESCRIPTOR_LENGTH = 8448;
/** Produces an 8,448-element, L2-normalized visual place descriptor. */
class MegaLoc extends ggml_model_1.GgmlModel {
    constructor(options) {
        super("MegaLoc", "megaloc", options);
    }
    embed(image, options) {
        const input = (0, ggml_model_1.withRawRgb)({ type: "embedding", content: image }, options);
        return this.runJob(input, "MegaLoc embedding job", (collected) => {
            const result = Array.isArray(collected) ? collected[0] : collected;
            return result instanceof Float32Array && result.length === DESCRIPTOR_LENGTH ? result : null;
        }, "MegaLoc returned an invalid descriptor");
    }
}
exports.MegaLoc = MegaLoc;
