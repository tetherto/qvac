'use strict'

const binding = require('./binding')

// Mirrors `enum llama_params_fit_status` in llama.h.
const FIT_STATUS = Object.freeze({
  SUCCESS: 0, // projected to fit
  FAILURE: 1, // could not find a config that fits device memory
  ERROR: 2 // hard error, e.g. no model at the given path
})

function validateNumber (config, key) {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`fit-llamacpp: config.${key} must be a finite number when provided`)
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
 * @param {object} config
 * @param {string} config.modelPath  Absolute path to the GGUF file.
 * @param {number} [config.nCtx]      Desired context. 0 lets the fitter pick.
 * @param {number} [config.nCtxMin]   Lower bound when reducing context.
 * @param {number} [config.nBatch]    Logical batch size (0 = llama default).
 * @param {number} [config.nUbatch]   Physical batch size (0 = llama default).
 * @param {number} [config.nGpuLayers] Pin offload layer count; omit to auto-fit.
 * @param {number} [config.marginMiB] Free headroom to leave per device (MiB).
 * @returns {{ status: number, fits: boolean, nGpuLayers: number, nCtx: number,
 *   nBatch: number, nUbatch: number, maxDevices: number, tensorSplit: number[] }}
 */
function fitParams (config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('fit-llamacpp: config object is required')
  }
  if (typeof config.modelPath !== 'string' || config.modelPath.length === 0) {
    throw new TypeError('fit-llamacpp: config.modelPath must be a non-empty string')
  }
  for (const key of ['nCtx', 'nCtxMin', 'nBatch', 'nUbatch', 'nGpuLayers', 'marginMiB']) {
    validateNumber(config, key)
  }
  return binding.paramsFit(config)
}

module.exports = { fitParams, FIT_STATUS }
