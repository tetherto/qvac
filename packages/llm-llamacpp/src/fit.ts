import { resolveBackendsDir } from './addon'

export interface LlamaFitRequest {
  /** Absolute path to the GGUF, or to the registry's weightless copy. */
  modelPath: string
  /** Layers to offload; a negative value means all of them. */
  gpuLayers?: number
  mainGpu?: number
  /** 0 lets the fitter choose, which is the only case it may reduce. */
  ctxSize?: number
  batchSize?: number
  ubatchSize?: number
  /** Floor the fitter may not reduce the context below. */
  minCtxSize?: number
  /** Memory to leave free on every device. */
  marginBytes?: number
  /** Where the dynamically-loaded ggml backends live. */
  backendsDir?: string

  /**
   * The fitter rewrites only fields still holding a llama default, so one left
   * unset is chosen by it rather than matched to the load you intend.
   */
  splitMode?: number
  /** `ggml_type` of the K cache; a quantised cache needs less memory. */
  typeK?: number
  /** `ggml_type` of the V cache. */
  typeV?: number
  /** `llama_flash_attn_type`; changes both cache and working memory. */
  flashAttnType?: number
  /** Whether the load uses the full-size sliding-window cache. */
  swaFull?: boolean
}

export type LlamaFitStatus = 'fits' | 'does-not-fit' | 'error'

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
  /** `fits`, `does-not-fit`, `model-unreadable` or `no-backend-device`. */
  reason: string
  /** What fits, which is not always what the request asked for. */
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
 */
export function assessFit(request: LlamaFitRequest): LlamaFitResult {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
  const binding = require('./binding.js') as FitBinding

  return binding.assessFit({
    backendsDir: resolveBackendsDir(),
    ...request
  })
}
