export interface FitConfig {
  /** Absolute path to the GGUF weights file. */
  modelPath: string
  /**
   * Directory holding the packaged ggml backends. Required wherever backends
   * ship as separate shared libraries — without it the fitter sees no devices
   * and reports ERROR. Omit for a statically linked build.
   */
  backendsDir?: string
  /**
   * Desired context size. 0 (default) lets the fitter choose down to nCtxMin;
   * any other value is a hard constraint and is returned unchanged.
   */
  nCtx?: number
  /** Lower bound when shrinking the context. 0 (default) means 4096. */
  nCtxMin?: number
  /** Logical batch size. 0 = llama default. */
  nBatch?: number
  /** Physical batch size. 0 = llama default. */
  nUbatch?: number
  /**
   * Pin the GPU offload layer count; omit to let the fitter choose. Per
   * llama.h a negative value means "all layers", so negatives are valid.
   *
   * Only a *non-default* value pins: the fitter rewrites any field still
   * holding its llama default, and -1 is the default for this one. Passing -1
   * is therefore equivalent to omitting it. Use 0 or a positive count (or any
   * negative other than -1) to make offload a hard constraint.
   */
  nGpuLayers?: number
  /** Free headroom to leave on every device, in MiB (default 1024). */
  marginMiB?: number
}

/** A tensor buffer-type override the fitter selected. */
export interface FitBuftOverride {
  /** Tensor-name pattern the override applies to. */
  pattern: string
  /** ggml buffer type the matching tensors were placed in. */
  bufferType: string
}

/** What the fitter measured against. Present on every outcome. */
export interface FitDeviceInventory {
  /**
   * Upper bound on addressable devices (llama_max_devices()). A build-time
   * constant, not a detection result — never read it as "a device was found".
   */
  maxDevices: number
  /** Devices actually registered (ggml_backend_dev_count()). 0 yields ERROR. */
  nDevices: number
  /** Of those, how many are accelerators (GPU or iGPU). 0 means host-only. */
  nGpuDevices: number
}

/** The fitted load plan. Only meaningful on a SUCCESS. */
export interface FitPlan {
  /**
   * Fitted number of layers to offload to GPU. Negative means "all layers"
   * (the llama default), which is what comes back when the fitter had no
   * offload decision to make — e.g. on a host with no accelerator. Check
   * `nGpuDevices` before reading this as a plan.
   */
  nGpuLayers: number
  /** Fitted context size. Always concrete, never 0. */
  nCtx: number
  /** Fitted logical batch size. */
  nBatch: number
  /** Fitted physical batch size. */
  nUbatch: number
  /** Offload proportions, one entry per device. */
  tensorSplit: number[]
  /**
   * Placement the fitter chose. Empty when it needed none. A plan carrying
   * overrides is only reproducible if the real load applies them too.
   */
  buftOverrides: FitBuftOverride[]
}

/**
 * Outcome of a fit, discriminated on `status`.
 *
 * Narrowing on `status` (or `fits`) tells the compiler which fields carry
 * meaning: the plan is only valid on SUCCESS, and every non-success branch
 * carries a stable `reason` so an SDK can tell "won't fit on this hardware"
 * apart from "could not read the model" or "no backend registered".
 */
export type FitResult =
  | ({ status: 0, fits: true, reason: 'fits' } & FitPlan & FitDeviceInventory)
  | ({ status: 1, fits: false, reason: 'does-not-fit' } & Partial<FitPlan> & FitDeviceInventory)
  | ({ status: 2, fits: false, reason: 'model-unreadable' | 'no-backend-device' } & Partial<FitPlan> & FitDeviceInventory)

/** Stable, machine-readable explanation of a fit outcome. */
export type FitReason = FitResult['reason']

export const FIT_STATUS: {
  readonly SUCCESS: 0
  readonly FAILURE: 1
  readonly ERROR: 2
}

/**
 * Runs a memory-fit preflight for a llama.cpp GGUF model. Synchronous, blocking,
 * and does not load weights (the fitter simulates allocations).
 *
 * Calls are serialised process-wide: `llama_params_fit` mutates global llama
 * logger state and is not thread safe, so concurrent callers block rather than
 * run together.
 */
export function fitParams (config: FitConfig): FitResult
