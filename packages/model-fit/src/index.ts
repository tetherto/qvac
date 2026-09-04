/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require('bare-fs')
import path = require('bare-path')
/* eslint-enable @typescript-eslint/no-require-imports */

/** Shape of the native addon this module wraps. */
interface FitBinding {
  paramsFit(config: FitConfig): FitResult
}

export interface FitConfig {
  /**
   * Path to the GGUF weights file.
   *
   * Must be absolute; a relative path throws. It would otherwise resolve
   * against the process working directory, so the same call could name a
   * different file — or no file — from one launch to the next.
   */
  modelPath: string
  /**
   * Directory holding ggml backend shared libraries. `@qvac/fabric`'s
   * `prebuilds/` is used when omitted (desktop); on mobile the packed worklet
   * falls back to this package's `prebuilds/`. Native code appends
   * `BACKENDS_SUBDIR` (`<host>/qvac__fabric`).
   *
   * Must be an absolute path that resolves to an existing directory; anything
   * else throws.
   *
   * SECURITY: every backend library found here is `dlopen`ed into the calling
   * process. Pass an application-controlled location only — never a value
   * derived from remote or user input.
   */
  backendsDir?: string
  /**
   * Desired context size. 0 (default) lets the fitter choose down to nCtxMin;
   * any other value is a hard constraint and is returned unchanged.
   *
   * Throws if it exceeds the context length the model declares. This addon
   * exposes no RoPE scaling knobs, so the model's own declared length is the
   * most any caller can legitimately ask for.
   */
  nCtx?: number
  /**
   * Lower bound when shrinking the context. 0 (default) means 4096, clamped
   * down to the model's declared context length when that is smaller.
   *
   * An explicit value throws if it exceeds the declared context length, for
   * the same reason `nCtx` does — the `nCtxMin <= nCtx` relationship check
   * does not apply when `nCtx` is 0.
   */
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
  /**
   * The fields below state the load you intend to perform. `common_fit_params`
   * rewrites only parameters still holding their llama default, so setting one
   * makes it a hard constraint the projection fits *around*, and omitting one
   * leaves the fitter free to choose it and report the choice back on the plan.
   *
   * Pass them whenever the real load has already decided them — a projection
   * measured against llama's defaults does not describe a load that uses
   * something else.
   *
   * `enum llama_split_mode`: how the model splits across multiple GPUs.
   */
  splitMode?: number
  /** Device holding the model, or -1 for an explicit CPU-only NONE placement. */
  mainGpu?: number
  /** `ggml_type` of the K cache. A quantised KV needs less memory than F16. */
  typeK?: number
  /** `ggml_type` of the V cache. Same reasoning as `typeK`. */
  typeV?: number
  /** `enum llama_flash_attn_type`. Changes KV/compute memory. */
  flashAttnType?: number
  /** Whether the intended load uses the full-size SWA cache. */
  swaFull?: boolean
}

/** A tensor buffer-type override the fitter selected. */
export interface FitBuftOverride {
  /** Tensor-name pattern the override applies to. */
  pattern: string
  /** ggml buffer type the matching tensors were placed in. */
  bufferType: string
}

/**
 * Projected memory for one device — or the trailing `"host"` row — at the
 * resolved parameters, in bytes. `totalBytes`/`freeBytes` are the budget the
 * verdict was judged against; the remaining fields are the projected demand.
 * Advisory evidence: it shows how far a verdict sat from its budget, it is not
 * an admission input on its own.
 */
export interface FitProjectionRow {
  /** Device name as the backend reports it, or `"host"` for the host row. */
  name: string
  totalBytes: number
  freeBytes: number
  modelBytes: number
  contextBytes: number
  computeBytes: number
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
  /**
   * Per-device projected memory at the resolved parameters, ending with the
   * host row. Populated on SUCCESS and FAILURE — a does-not-fit with numbers
   * is the point. Empty on ERROR, and empty when the extra no-alloc probe
   * that produces it fails: the projection is the verdict's explanation, and
   * a missing explanation never changes the verdict. Optional because results
   * decoded from an older addon or process runner predate the field.
   */
  projection?: FitProjectionRow[]
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
  /**
   * `enum llama_split_mode` — how the model is split across multiple GPUs.
   *
   * This and the four fields below go into the fitter at their llama defaults,
   * which is the exact condition under which it may rewrite them ("only
   * parameters that have the same value as in llama_default_model_params are
   * modified"). They are part of the plan for that reason: loading with your
   * own defaults instead of these can produce different placement than the one
   * projected to fit.
   */
  splitMode: number
  /** Device holding the model, or -1 for an explicit CPU-only NONE placement. */
  mainGpu: number
  /** `enum ggml_type` for the K cache. Changes KV memory, so it changes the fit. */
  typeK: number
  /** `enum ggml_type` for the V cache. Changes KV memory, so it changes the fit. */
  typeV: number
  /** `enum llama_flash_attn_type` — alters KV/compute memory, so it is load-bearing. */
  flashAttnType: number
}

/**
 * Outcome of a fit, discriminated on `status`.
 *
 * Narrowing on `status` (or `fits`) tells the compiler which fields carry
 * meaning: the plan is only valid on SUCCESS, and every non-success branch
 * carries a stable `reason` so an SDK can tell "won't fit on this hardware"
 * apart from "could not read the model" or "no backend registered".
 *
 * This is the contract of `fitParams()` and nothing else. The raw llama-load
 * path adds one further outcome, `unsupported-config`, which this API cannot
 * produce — it has no normalization step to fail — so that reason lives on
 * `FitLlamaResult` in `./process` rather than widening the union every existing
 * consumer has to narrow.
 */
export type FitResult =
  | ({ status: 0, fits: true, reason: 'fits' } & FitPlan & FitDeviceInventory)
  | ({ status: 1, fits: false, reason: 'does-not-fit' } & Partial<FitPlan> & FitDeviceInventory)
  | ({ status: 2, fits: false, reason: 'model-unreadable' | 'no-backend-device' } & Partial<FitPlan> & FitDeviceInventory)

/** Stable, machine-readable explanation of a `fitParams()` outcome. */
export type FitReason = FitResult['reason']

// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
const binding = require('./binding') as FitBinding

// The ggml compute backends (GGML_BACKEND_DL modules) ship exactly once, in the
// @qvac/fabric dependency (prebuilds/<host>/qvac__fabric). We deliberately do
// not copy them into this addon. On desktop, resolve the single @qvac/fabric
// install. On mobile the package tree isn't resolvable at runtime (the worklet
// runs from a packed bundle), so fall back to this addon's own prebuilds.
// Native code appends BACKENDS_SUBDIR ("<host>/qvac__fabric") to the root.
// Return undefined only when neither directory exists, so a statically linked
// build still skips backendsDir.
function resolveBackendsDir (): string | undefined {
  try {
    const fabricPkg = require.resolve('@qvac/fabric/package')
    const fabricPrebuilds = path.join(path.dirname(fabricPkg), 'prebuilds')
    if (fs.statSync(fabricPrebuilds).isDirectory()) return fabricPrebuilds
  } catch {
    // Mobile worklets cannot resolve the @qvac/fabric package tree.
  }
  try {
    const packaged = path.join(__dirname, 'prebuilds')
    return fs.statSync(packaged).isDirectory() ? packaged : undefined
  } catch {
    return undefined
  }
}

/** Mirrors `enum common_params_fit_status` in llama.cpp's common/fit.h. */
export const FIT_STATUS = Object.freeze({
  SUCCESS: 0, // projected to fit
  FAILURE: 1, // could not find a config that fits device memory
  ERROR: 2 // hard error, e.g. no model at the given path
} as const)

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
  mainGpu: { min: -1, max: INT32_MAX },
  typeK: { min: 0, max: INT32_MAX },
  typeV: { min: 0, max: INT32_MAX },
  flashAttnType: { min: -1, max: 1 }
})

/**
 * Fields validated numerically. Every one is an optional `number` on
 * `FitConfig`, which is what lets the loop below index the config directly.
 */
type NumericField = keyof typeof NUMERIC_FIELDS

function validateNumber (config: FitConfig, key: NumericField, min: number, max: number): void {
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
function validateRelationships (config: FitConfig): void {
  const nBatch = config.nBatch ?? 0
  const nUbatch = config.nUbatch ?? 0
  const nCtx = config.nCtx ?? 0
  const nCtxMin = config.nCtxMin ?? 0
  if (nBatch > 0 && nUbatch > 0 && nUbatch > nBatch) {
    throw new RangeError('model-fit: config.nUbatch must not exceed config.nBatch')
  }
  if (nCtx > 0 && nCtxMin > 0 && nCtxMin > nCtx) {
    throw new RangeError('model-fit: config.nCtxMin must not exceed config.nCtx')
  }
  if (
    config.mainGpu === -1 &&
    (config.nGpuLayers !== 0 || config.splitMode !== 0)
  ) {
    throw new RangeError(
      'model-fit: config.mainGpu -1 requires config.nGpuLayers 0 and config.splitMode NONE'
    )
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
 * `backendsDir` is omitted this package resolves `@qvac/fabric`'s `prebuilds/`
 * (desktop) or this addon's `prebuilds/` (mobile worklet). Omit only for a
 * statically linked build, which self-registers.
 * Every backend library in that directory is `dlopen`ed into this process, so
 * it must be an application-controlled location — never remote or user input.
 */
export function fitParams (config: FitConfig): FitResult {
  if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('model-fit: config object is required')
  }
  if (typeof config.modelPath !== 'string' || config.modelPath.length === 0) {
    throw new TypeError('model-fit: config.modelPath must be a non-empty string')
  }
  // A relative path depends on the process working directory, so enforce the
  // documented absolute-path contract before the native fopen.
  if (!path.isAbsolute(config.modelPath)) {
    throw new TypeError(`model-fit: config.modelPath must be an absolute path, got '${config.modelPath}'`)
  }
  if (config.backendsDir !== undefined && (typeof config.backendsDir !== 'string' || config.backendsDir.length === 0)) {
    throw new TypeError('model-fit: config.backendsDir must be a non-empty string when provided')
  }
  for (const key of Object.keys(NUMERIC_FIELDS) as NumericField[]) {
    const { min, max } = NUMERIC_FIELDS[key]
    validateNumber(config, key, min, max)
  }
  if (config.swaFull !== undefined && typeof config.swaFull !== 'boolean') {
    throw new TypeError('model-fit: config.swaFull must be a boolean when provided')
  }
  validateRelationships(config)

  // An explicit backendsDir always wins, including a bad one — it is the
  // caller's statement of intent and has to fail loudly rather than be
  // silently replaced by ours.
  let resolved = config
  if (config.backendsDir === undefined) {
    const packaged = resolveBackendsDir()
    if (packaged !== undefined) {
      resolved = { ...config, backendsDir: packaged }
    }
  }

  return binding.paramsFit(resolved)
}
