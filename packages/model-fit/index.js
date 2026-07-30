'use strict'

const binding = require('./binding')

// Mirrors `enum llama_params_fit_status` in llama.h.
const FIT_STATUS = Object.freeze({
  SUCCESS: 0, // projected to fit
  FAILURE: 1, // could not find a config that fits device memory
  ERROR: 2 // hard error, e.g. no model at the given path
})

const UINT32_MAX = 4294967295
const INT32_MAX = 2147483647
const INT32_MIN = -2147483648

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
  mainGpu: { min: 0, max: INT32_MAX },
  typeK: { min: 0, max: INT32_MAX },
  typeV: { min: 0, max: INT32_MAX },
  flashAttnType: { min: -1, max: 1 }
})

function validateNumber (config, key, min, max) {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`model-fit: config.${key} must be a safe integer when provided`)
  }
  if (value < min || value > max) {
    throw new RangeError(`model-fit: config.${key} must be between ${min} and ${max}`)
  }
}

// Relationships the native side would otherwise accept and the fitter would
// then either reject obscurely or silently reinterpret.
function validateRelationships (config) {
  const { nBatch, nUbatch, nCtx, nCtxMin } = config
  if (nBatch > 0 && nUbatch > 0 && nUbatch > nBatch) {
    throw new RangeError('model-fit: config.nUbatch must not exceed config.nBatch')
  }
  if (nCtx > 0 && nCtxMin > 0 && nCtxMin > nCtx) {
    throw new RangeError('model-fit: config.nCtxMin must not exceed config.nCtx')
  }
}

/**
 * Memory-fit preflight for a llama.cpp GGUF model. Runs `llama_params_fit`,
 * which simulates allocations (no weights are loaded) to project whether the
 * model fits available device memory and, if so, with which offload plan.
 *
 * This is a synchronous, blocking native call. It is designed to run in its own
 * short-lived worklet so that any backend/driver instability during probing
 * stays isolated from the inference worker.
 *
 * Calls are serialised process-wide: `llama_params_fit` mutates global llama
 * logger state and is not thread safe, so concurrent callers block instead of
 * running together.
 *
 * Backends must be registered before the fitter can see any device, so pass
 * `backendsDir` wherever the packaged ggml backends ship as separate shared
 * libraries; omit it for a statically linked build, which self-registers.
 * Every backend library in that directory is `dlopen`ed into this process, so
 * it must be an application-controlled location — never remote or user input.
 *
 * @param {object} config
 * @param {string} config.modelPath  Absolute path to the GGUF file.
 * @param {string} [config.backendsDir] Absolute directory holding the backends.
 * @param {number} [config.nCtx]      Desired context. 0 lets the fitter pick.
 * @param {number} [config.nCtxMin]   Lower bound when reducing context.
 * @param {number} [config.nBatch]    Logical batch size (0 = llama default).
 * @param {number} [config.nUbatch]   Physical batch size (0 = llama default).
 * @param {number} [config.nGpuLayers] Pin offload layer count; omit to auto-fit.
 * @param {number} [config.marginMiB] Free headroom to leave per device (MiB).
 * @param {number} [config.splitMode]  `llama_split_mode`; omit to auto-fit.
 * @param {number} [config.mainGpu]    Device for the model when splitMode NONE.
 * @param {number} [config.typeK]      `ggml_type` of the K cache.
 * @param {number} [config.typeV]      `ggml_type` of the V cache.
 * @param {number} [config.flashAttnType] `llama_flash_attn_type`.
 * @returns {{ status: number, fits: boolean, nGpuLayers: number, nCtx: number,
 *   nBatch: number, nUbatch: number, maxDevices: number, tensorSplit: number[] }}
 */
function fitParams (config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('model-fit: config object is required')
  }
  if (typeof config.modelPath !== 'string' || config.modelPath.length === 0) {
    throw new TypeError('model-fit: config.modelPath must be a non-empty string')
  }
  if (config.backendsDir !== undefined && (typeof config.backendsDir !== 'string' || config.backendsDir.length === 0)) {
    throw new TypeError('model-fit: config.backendsDir must be a non-empty string when provided')
  }
  for (const [key, { min, max }] of Object.entries(NUMERIC_FIELDS)) {
    validateNumber(config, key, min, max)
  }
  validateRelationships(config)
  return binding.paramsFit(config)
}

module.exports = { fitParams, FIT_STATUS }
