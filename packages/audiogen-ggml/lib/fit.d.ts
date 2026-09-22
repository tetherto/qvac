export interface AudiogenFitRequest {
  /** Directory holding the four stage GGUFs; explicit paths win over it. */
  modelsDir?: string
  textEncoderPath?: string
  lmPath?: string
  ditPath?: string
  vaePath?: string

  /** > 0 requests the GPU stack, with the fallbacks a real load applies. */
  gpuLayers?: number
  threads?: number
  backendsDir?: string

  /** Longest single generation the projection must accommodate. */
  durationSeconds?: number
  textTokens?: number
  lyricTokens?: number
  /** 0 derives it from the text and lyric budgets. */
  lmPromptTokens?: number
  /** 0 derives it from the duration, as the pipeline does. */
  lmMaxNewTokens?: number
  lmCfgScale?: number
  /** 0 picks CFG or no CFG from the checkpoint. */
  guidanceScale?: number
  /** Projects the extra VAE-encoder phase a cover or reference request loads. */
  withSourceAudio?: boolean
  /** -1 mirrors the engine, 0 forces the staged projection, 1 all-resident. */
  keepStages?: number
  /** Free memory that must remain for the projection to count as fitting. Defaults to 256 MiB. */
  marginBytes?: number
}

export type AudiogenFitStatus = 'fits' | 'does-not-fit' | 'error'

export interface AudiogenFitResult {
  status: AudiogenFitStatus
  /** The engine's own wording, e.g. `model-unreadable`, `workload-too-large`. */
  reason: string
  modelName: string
  isTurbo: boolean
  deviceName: string
  deviceIsCpu: boolean
  /** The device pool is system RAM, so host bytes compete with device bytes. */
  deviceSharesHostMemory: boolean
  deviceFreeBytes: number
  deviceTotalBytes: number
  /** Peak across the pipeline phases under the projected residency mode. */
  deviceBytes: number
  hostBytes: number
  /** Host capacity, which is a budget of its own where the device has its own memory. */
  hostFreeBytes: number
  hostTotalBytes: number
  stagesResident: boolean
  report: string
}

export function assessFit(request: AudiogenFitRequest): AudiogenFitResult
