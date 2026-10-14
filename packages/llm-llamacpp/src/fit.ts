
export interface LlamaFitRequest {
  /** Absolute path to the GGUF, or to the registry's weightless copy. */
  modelPath: string
  /** The load, as `loadModel` takes it, resolved by the same code that load runs. */
  config?: Record<string, string>
  /** Floor the fitter may not reduce an unpinned context below. */
  minCtxSize?: number
  /** Memory to leave free on every device, held to against the load's own `fit-target`. */
  marginBytes?: number
}

export type LlamaFitStatus = 'fits' | 'does-not-fit' | 'error'

export type LlamaFitReason =
  | 'fits'
  | 'does-not-fit'
  | 'model-unreadable'
  | 'no-backend-device'
  | 'unsupported-config'

export interface LlamaFitDevice {
  name: string
  totalBytes: number
  freeBytes: number
  modelBytes: number
  contextBytes: number
  computeBytes: number
}

export interface LlamaFitResult {
  status: LlamaFitStatus
  reason: LlamaFitReason
  /** The layer count the placement resolved to. */
  gpuLayers: number
  ctxSize: number
  /** One row per device the model was assigned to, then a `host` row. */
  devices: LlamaFitDevice[]
  /** Model, context and compute summed across the devices, host excluded. */
  deviceBytes: number
  /** The same, for the trailing host row. */
  hostBytes: number
  trainCtxSize: number
  expertCount: number
}

interface FitBinding {
  assessFit(request: LlamaFitRequest): LlamaFitResult
}

/**
 * Projects one model against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of a model answers the
 * same as the model itself, so this can run before anything is downloaded.
 *
 * A model the fitter cannot read comes back as `status: "error"`; only a broken
 * request throws.
 *
 * Runs synchronously on the calling thread and builds the model twice without
 * allocating weights, so a caller that must stay responsive runs it off its
 * own loop.
 *
 * The projection reads the model's vocabulary, and llama asserts on a
 * vocabulary it finds inconsistent. An assert aborts rather than throwing, so
 * a corrupt file ends the process instead of returning a status: take the
 * model from a source you trust, or call this behind a process boundary.
 */
export function assessFit(request: LlamaFitRequest): LlamaFitResult {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
  const binding = require('./binding.js') as FitBinding

  return binding.assessFit({ ...request, config: { ...request.config } })
}
