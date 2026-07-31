"use strict";
/**
 * Shared engine-agnostic types for the unified `@qvac/asr-ggml` surface.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackendId = void 0;
/** Numeric code identifying the compute backend selected by the engine. */
var BackendId;
(function (BackendId) {
    BackendId[BackendId["CPU"] = 0] = "CPU";
    BackendId[BackendId["Metal"] = 1] = "Metal";
    BackendId[BackendId["CUDA"] = 2] = "CUDA";
    BackendId[BackendId["Vulkan"] = 3] = "Vulkan";
    BackendId[BackendId["OpenCL"] = 4] = "OpenCL";
    BackendId[BackendId["Other"] = 99] = "Other";
})(BackendId || (exports.BackendId = BackendId = {}));
