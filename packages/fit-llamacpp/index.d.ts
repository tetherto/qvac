export interface FitConfig {
  /** Absolute path to the GGUF weights file. */
  modelPath: string
  /** Desired context size. 0 (default) lets the fitter choose down to nCtxMin. */
  nCtx?: number
  /** Lower bound the fitter may shrink the context to when freeing memory. */
  nCtxMin?: number
  /** Logical batch size. 0 = llama default. */
  nBatch?: number
  /** Physical batch size. 0 = llama default. */
  nUbatch?: number
  /** Pin the GPU offload layer count; omit to let the fitter choose. */
  nGpuLayers?: number
  /** Free headroom to leave on every device, in MiB (default 1024). */
  marginMiB?: number
}

export interface FitResult {
  /** 0 SUCCESS, 1 FAILURE (won't fit), 2 ERROR — mirrors llama_params_fit_status. */
  status: number
  /** true iff status === SUCCESS. */
  fits: boolean
  /** Fitted number of layers to offload to GPU. */
  nGpuLayers: number
  /** Fitted context size. */
  nCtx: number
  /** Fitted logical batch size. */
  nBatch: number
  /** Fitted physical batch size. */
  nUbatch: number
  /** Number of devices considered (llama_max_devices()). */
  maxDevices: number
  /** Offload proportions, one entry per device. */
  tensorSplit: number[]
}

export const FIT_STATUS: {
  readonly SUCCESS: 0
  readonly FAILURE: 1
  readonly ERROR: 2
}

/**
 * Runs a memory-fit preflight for a llama.cpp GGUF model. Synchronous, blocking,
 * and does not load weights (the fitter simulates allocations).
 */
export function fitParams (config: FitConfig): FitResult
