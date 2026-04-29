export const DEFAULT_IMAGE_SIZE: number

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
  opts?: { size?: number, layout?: 'hwc' | 'chw' }
): Float32Array

export function padState (state: ArrayLike<number>, targetDim?: number): Float32Array

export function pickPrimaryGgufPath (files: string[]): string

declare const _default: typeof VlaModel
export default _default
