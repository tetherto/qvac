import type { QvacResponse } from '@qvac/infer-base'

export interface TranslationNmtcppFiles {
  model: string
  srcVocab?: string
  dstVocab?: string
  pivotModel?: string
  pivotSrcVocab?: string
  pivotDstVocab?: string
}

export interface TranslationNmtcppParams {
  dstLang: string
  srcLang: string
  [key: string]: unknown
}

export interface TranslationNmtcppArgs {
  files: TranslationNmtcppFiles
  params: TranslationNmtcppParams
  config?: TranslationNmtcppConfig
  logger?: any
  opts?: { stats?: boolean }
  [key: string]: unknown
}

export interface TranslationNmtcppModelTypes {
  readonly IndicTrans: "IndicTrans"
  readonly Bergamot: "Bergamot"
}

export interface TranslationNmtcppConfig {
  modelType: TranslationNmtcppModelTypes[keyof TranslationNmtcppModelTypes]
  pivotConfig?: Record<string, unknown>

  /**
   * Enable GPU (non-CPU) compute backend. Read once at load() time.
   * Bergamot is CPU-only by design — this flag is a no-op for that backend.
   *
   * `use_gpu` mirrors the C-struct field (`nmt_context_params::use_gpu`)
   * and is the primary key. `useGPU` is the camelCase alias matching the
   * `ocr-onnx` convention (caps acronym). Both forms are accepted; if
   * both are set, `use_gpu` takes precedence.
   * @default false
   */
  use_gpu?: boolean
  useGPU?: boolean

  /**
   * Case-insensitive substring filter over the ggml device name when selecting
   * a compute backend (e.g. "vulkan", "vulkan0", "opencl", "metal"). When set,
   * replaces the default gated selector with a single explicit pass.
   * An explicit "opencl" bypasses the build-time USE_OPENCL guard.
   *
   * `gpu_backend` mirrors the C-struct field and is the primary key.
   * `gpuBackend` is the camelCase alias matching the `ocr-onnx` convention.
   * Both forms are accepted; if both are set, `gpu_backend` takes precedence.
   */
  gpu_backend?: string
  gpuBackend?: string

  /**
   * Ordinal within the matching compute devices. Defaults to 0.
   * Example: { gpu_backend: "vulkan", gpu_device: 1 } → second Vulkan adapter.
   *
   * `gpu_device` mirrors the C struct and is the primary key.
   * `gpuDevice` is the camelCase alias.
   * If both are set, `gpu_device` takes precedence.
   */
  gpu_device?: number
  gpuDevice?: number

  /**
   * Path to the directory containing backend shared libraries
   * (libqvac-ggml-vulkan.so, etc.). Defaults to `<package>/prebuilds` — where
   * npm install places the shipped prebuilds.
   */
  backendsDir?: string

  /**
   * Android-only. Writable directory for the OpenCL JIT kernel cache.
   * Forwarded to the backend via GGML_OPENCL_CACHE_DIR. Always provide an
   * app-writable path when exercising OpenCL on Android.
   */
  openclCacheDir?: string

  [key: string]: unknown
}

export interface InferenceClientState {
  configLoaded: boolean
  weightsLoaded: boolean
  destroyed: boolean
}

export default class TranslationNmtcpp {
  static readonly ModelTypes: TranslationNmtcppModelTypes
  constructor(args: TranslationNmtcppArgs)
  getState(): InferenceClientState
  load(): Promise<void>
  run(input: string): Promise<QvacResponse<string>>
  runBatch(texts: string[]): Promise<string[]>
  unload(): Promise<void>
  destroy(): Promise<void>

  /**
   * Returns the name of the compute backend that load() actually selected,
   * or one of the sentinels "Unloaded", "Bergamot-CPU", "CPU". Open-ended
   * device names like "Vulkan0", "OpenCL", "Metal" are also possible.
   * Call after load() to confirm use_gpu / gpu_backend took effect.
   *
   * Return-type note: `(string & {})` keeps the literal sentinels
   * IDE-completable. Plain `'Unloaded' | ... | string` collapses to `string`
   * via TypeScript's union absorption rule, hiding the sentinels from
   * autocomplete; `(string & {})` is the established workaround that
   * preserves both the open enum and the named members.
   */
  getActiveBackendName(): 'Unloaded' | 'Bergamot-CPU' | 'CPU' | (string & {})
}
