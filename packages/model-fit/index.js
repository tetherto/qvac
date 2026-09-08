"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIT_STATUS = void 0;
exports.fitParams = fitParams;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
const binding = require('./binding');
// The ggml compute backends (GGML_BACKEND_DL modules) ship exactly once, in the
// @qvac/fabric dependency (prebuilds/<host>/qvac__fabric). We deliberately do
// not copy them into this addon. On desktop, resolve the single @qvac/fabric
// install. On mobile the package tree isn't resolvable at runtime (the worklet
// runs from a packed bundle), so fall back to this addon's own prebuilds.
// Native code appends BACKENDS_SUBDIR ("<host>/qvac__fabric") to the root.
// Return undefined only when neither directory exists, so a statically linked
// build still skips backendsDir.
function resolveBackendsDir() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- @qvac/fabric/platform is CJS and absent from 0.10.0 fat installs.
        const fabricPlatform = require('@qvac/fabric/platform');
        const fabricPrebuilds = fabricPlatform.resolvePlatformPrebuilds();
        if (fabricPrebuilds && fs.statSync(fabricPrebuilds).isDirectory())
            return fabricPrebuilds;
    }
    catch {
        // Fat 0.10.0 install has no platform helper.
    }
    try {
        const fabricPkg = require.resolve('@qvac/fabric/package');
        const fabricPrebuilds = path.join(path.dirname(fabricPkg), 'prebuilds');
        if (fs.statSync(fabricPrebuilds).isDirectory())
            return fabricPrebuilds;
    }
    catch {
        // Mobile worklets cannot resolve the @qvac/fabric package tree.
    }
    try {
        const packaged = path.join(__dirname, 'prebuilds');
        return fs.statSync(packaged).isDirectory() ? packaged : undefined;
    }
    catch {
        return undefined;
    }
}
/** Mirrors `enum common_params_fit_status` in llama.cpp's common/fit.h. */
exports.FIT_STATUS = Object.freeze({
    SUCCESS: 0, // projected to fit
    FAILURE: 1, // could not find a config that fits device memory
    ERROR: 2 // hard error, e.g. no model at the given path
});
const UINT32_MAX = 4294967295;
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;
// Every numeric field crosses into C++ as a uint32_t or int32_t. Fractions
// truncate there and out-of-range values wrap, so `marginMiB: -1` would silently
// become a ~4 PiB margin that nothing can ever satisfy. Reject at the boundary.
//
// nGpuLayers is the one signed field: llama.h documents "a negative value means
// all layers", so negatives are valid input, not a mistake.
const NUMERIC_FIELDS = Object.freeze({
    nCtx: { min: 0, max: UINT32_MAX },
    nCtxMin: { min: 0, max: UINT32_MAX },
    nBatch: { min: 0, max: UINT32_MAX },
    nUbatch: { min: 0, max: UINT32_MAX },
    nGpuLayers: { min: INT32_MIN, max: INT32_MAX },
    marginMiB: { min: 0, max: UINT32_MAX },
    // Intended-load fields. splitMode and flashAttnType are small, stable enums,
    // so their exact domains are checked here as well as natively. typeK/typeV are
    // ggml_type indices whose upper bound (GGML_TYPE_COUNT) moves with upstream —
    // bounding them precisely here would mean re-editing this file on every bump,
    // so the shape check lives here and the exact bound stays in the binding,
    // which is compiled against the same ggml.h.
    splitMode: { min: 0, max: 3 },
    mainGpu: { min: -1, max: INT32_MAX },
    typeK: { min: 0, max: INT32_MAX },
    typeV: { min: 0, max: INT32_MAX },
    flashAttnType: { min: -1, max: 1 }
});
function validateNumber(config, key, min, max) {
    const value = config[key];
    if (value === undefined)
        return;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError(`model-fit: config.${key} must be a safe integer when provided`);
    }
    if (value < min || value > max) {
        throw new RangeError(`model-fit: config.${key} must be between ${min} and ${max}`);
    }
}
// Relationships the native side would otherwise accept and the fitter would
// then either reject obscurely or silently reinterpret.
function validateRelationships(config) {
    const nBatch = config.nBatch ?? 0;
    const nUbatch = config.nUbatch ?? 0;
    const nCtx = config.nCtx ?? 0;
    const nCtxMin = config.nCtxMin ?? 0;
    if (nBatch > 0 && nUbatch > 0 && nUbatch > nBatch) {
        throw new RangeError('model-fit: config.nUbatch must not exceed config.nBatch');
    }
    if (nCtx > 0 && nCtxMin > 0 && nCtxMin > nCtx) {
        throw new RangeError('model-fit: config.nCtxMin must not exceed config.nCtx');
    }
    if (config.mainGpu === -1 &&
        (config.nGpuLayers !== 0 || config.splitMode !== 0)) {
        throw new RangeError('model-fit: config.mainGpu -1 requires config.nGpuLayers 0 and config.splitMode NONE');
    }
}
/**
 * Memory-fit preflight for a llama.cpp GGUF model. Runs `common_fit_params`,
 * which simulates allocations (no weights are loaded) to project whether the
 * model fits available device memory and, if so, with which offload plan.
 *
 * This is a synchronous, blocking in-process native call. Callers that need
 * isolation should use `@qvac/model-fit/process` to run it in a disposable
 * Bare subprocess.
 *
 * Calls are serialised process-wide: `common_fit_params` mutates global llama
 * logger state and is not thread safe, so concurrent callers block instead of
 * running together.
 *
 * Backends must be registered before the fitter can see any device. When
 * `backendsDir` is omitted this package resolves the host
 * `@qvac/fabric-<platform>` package's `prebuilds/` (desktop) or this addon's
 * `prebuilds/` (mobile worklet). Omit only for a
 * statically linked build, which self-registers.
 * Every backend library in that directory is `dlopen`ed into this process, so
 * it must be an application-controlled location — never remote or user input.
 */
function fitParams(config) {
    if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError('model-fit: config object is required');
    }
    if (typeof config.modelPath !== 'string' || config.modelPath.length === 0) {
        throw new TypeError('model-fit: config.modelPath must be a non-empty string');
    }
    // A relative path depends on the process working directory, so enforce the
    // documented absolute-path contract before the native fopen.
    if (!path.isAbsolute(config.modelPath)) {
        throw new TypeError(`model-fit: config.modelPath must be an absolute path, got '${config.modelPath}'`);
    }
    if (config.backendsDir !== undefined && (typeof config.backendsDir !== 'string' || config.backendsDir.length === 0)) {
        throw new TypeError('model-fit: config.backendsDir must be a non-empty string when provided');
    }
    for (const key of Object.keys(NUMERIC_FIELDS)) {
        const { min, max } = NUMERIC_FIELDS[key];
        validateNumber(config, key, min, max);
    }
    if (config.swaFull !== undefined && typeof config.swaFull !== 'boolean') {
        throw new TypeError('model-fit: config.swaFull must be a boolean when provided');
    }
    validateRelationships(config);
    // An explicit backendsDir always wins, including a bad one — it is the
    // caller's statement of intent and has to fail loudly rather than be
    // silently replaced by ours.
    let resolved = config;
    if (config.backendsDir === undefined) {
        const packaged = resolveBackendsDir();
        if (packaged !== undefined) {
            resolved = { ...config, backendsDir: packaged };
        }
    }
    return binding.paramsFit(resolved);
}
