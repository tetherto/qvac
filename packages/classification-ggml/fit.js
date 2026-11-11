"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
const path = require("bare-path");
// Matches the `threads` bound createInstance enforces in the native addon.
const MAX_THREADS = 1024;
// An optional string the native side reads as a C string, which stops at the
// first NUL.
function checkOptionalString(value, name) {
    if (value === undefined || value === null)
        return;
    if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string`);
    }
    if (value.includes("\0")) {
        throw new TypeError(`${name} must not contain a NUL character`);
    }
}
function checkPositiveInteger(value, name) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
}
/**
 * Assess loading a model and running one inference, from the GGUF metadata.
 * The graphs are built and sized as load and inference build them, without
 * reading weight data or allocating buffers. Tensor data is not checked, so
 * a file whose weights `load()` rejects can still be reported as fitting.
 *
 * Each call initializes the selected backend, so it costs about what a
 * backend init costs. Concurrent calls run one at a time. A request that fails the checks here
 * rejects with a `TypeError` or `RangeError`. A model that cannot be read, an
 * unsupported GGUF, an unavailable backend, a BridgeDepth size inference would
 * reject or an otherwise invalid request rejects with an `InvalidArgument`
 * error; a backend that fails to initialize or a graph that cannot be sized
 * rejects with an `InternalError`.
 */
async function assessFit(request) {
    if (typeof request?.modelPath !== "string" || !path.isAbsolute(request.modelPath)) {
        throw new TypeError("modelPath must be an absolute path");
    }
    checkOptionalString(request.modelPath, "modelPath");
    checkOptionalString(request.backend, "backend");
    checkOptionalString(request.backendsDir, "backendsDir");
    if (request.workload !== undefined && request.workload !== null && typeof request.workload !== "object") {
        throw new TypeError("workload must be an object");
    }
    if (request.marginBytes !== undefined &&
        (!Number.isSafeInteger(request.marginBytes) || request.marginBytes < 0)) {
        throw new RangeError("marginBytes must be a non-negative safe integer");
    }
    if (request.threads !== undefined &&
        (!Number.isInteger(request.threads) || request.threads < 1 || request.threads > MAX_THREADS)) {
        throw new RangeError(`threads must be an integer between 1 and ${MAX_THREADS}`);
    }
    checkPositiveInteger(request.workload?.width, "workload.width");
    checkPositiveInteger(request.workload?.height, "workload.height");
    // Resolve lazily so importing this package never loads the native binding.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native prebuild is resolved lazily.
    const binding = require("./binding");
    return await binding.assessFit(request);
}
