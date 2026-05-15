export const DEFAULT_IMAGE_SIZE: number

export class QvacErrorAddonVla extends Error {
  code: number
}

export const ERR_CODES: Readonly<{
  FAILED_TO_LOAD_WEIGHTS: 30001
  FAILED_TO_DESTROY: 30002
  MODEL_NOT_FOUND: 30003
  INVALID_CONFIG: 30004
  MISSING_REQUIRED_PARAMETER: 30005
  INVALID_INPUT: 30006
  JOB_ALREADY_RUNNING: 30007
  INSTANCE_NOT_INITIALIZED: 30008
  MODEL_UNLOADED: 30009
  INFERENCE_FAILED: 30010
}>

export interface VlaHparams {
  chunkSize: number
  actionDim: number
  maxActionDim: number
  maxStateDim: number
  tokenizerMaxLength: number
  visionImageSize: number
}

export interface VlaRunInput {
  images: Float32Array[]
  imgWidth?: number
  imgHeight?: number
  state: Float32Array
  tokens: Int32Array
  mask: Uint8Array
  noise?: Float32Array | null
}

export interface VlaRunStats {
  vision_ms: number
  smollm2_compute_ms: number
  smollm2_total_ms: number
  ode_ms: number
  total_ms: number
  /** 0 = CPU backend, 1 = GPU backend (Vulkan / Metal / OpenCL). */
  backendDevice: number
}

export interface VlaRunResult {
  actions: Float32Array
  stats: VlaRunStats
}

export interface VlaModelOptions {
  files: { model: string[] }
  config?: Record<string, unknown>
  logger?: unknown
  opts?: { stats?: boolean }
}

export interface QvacResponse {
  await(): Promise<VlaRunResult>
  cancel(): Promise<void>
  on(event: string, listener: (...args: unknown[]) => void): this
}

export class VlaModel {
  constructor (options: VlaModelOptions)
  readonly hparams: VlaHparams | null
  /**
   * Name of the ggml backend the loaded model is running on
   * ("CPU" / "Vulkan" / "OpenCL" / "Metal"). `null` before `load()`.
   */
  readonly backendName: string | null
  load (opts?: { backend?: 'auto' | 'cpu' }): Promise<void>
  run (input: VlaRunInput): Promise<QvacResponse>
  pause (): Promise<void>
  cancel (): Promise<void>
  unload (): Promise<void>
  getState (): { configLoaded: boolean }
}

export function preprocessImage (
  pixels: Float32Array | Uint8Array | number[],
  width: number,
  height: number,
  opts?: {
    size?: number,
    layout?: 'hwc' | 'chw',
    /**
     * Pixel-range hint that skips the [0,255] vs [0,1] auto-detection
     * heuristic. Pass `1` if pixels are already in [0,1] (no rescale),
     * pass `1/255` if pixels are in [0,255] (rescale to [0,1]). Anything
     * else (including the literal `'auto'`) falls back to the heuristic.
     * Typed as `number | 'auto'` because TS literal types can't represent
     * `1/255` directly.
     */
    scale?: number | 'auto'
  }
): Float32Array

export function padState (state: ArrayLike<number>, targetDim?: number): Float32Array

declare const _default: typeof VlaModel
export default _default
