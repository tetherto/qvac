export const DEFAULT_IMAGE_SIZE: number

export interface VlaHparams {
  chunkSize: number
  actionDim: number
  maxActionDim: number
  maxStateDim: number
  tokenizerMaxLength: number
  visionImageSize: number
}

export interface VlaRunOptions {
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

export class VlaModel {
  constructor (ggufPath: string)
  readonly hparams: VlaHparams
  run (opts: VlaRunOptions): VlaRunResult
  destroy (): void
}

export function preprocessImage (
  pixels: Float32Array | Uint8Array | number[],
  width: number,
  height: number,
  opts?: { size?: number, layout?: 'hwc' | 'chw' }
): Float32Array

export function padState (state: ArrayLike<number>, targetDim?: number): Float32Array
