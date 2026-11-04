export type AudiogenFitEngine = 'acestep' | 'minimax'

export interface AudiogenFitRequest {
  /**
   * Engine that would run the load. Defaults to `acestep`. `minimax` is
   * projected on desktop builds; on Android and iOS it rejects.
   */
  engine?: AudiogenFitEngine
  /**
   * Directory holding the model GGUFs (the four ACE-Step stages, or the MiniMax
   * LM and synth pair); explicit paths win over it.
   */
  modelsDir?: string
  textEncoderPath?: string
  /** The ACE-Step or MiniMax LM GGUF. */
  lmPath?: string
  ditPath?: string
  vaePath?: string
  /** MiniMax synthesis GGUF; pairs with `lmPath`. */
  synthPath?: string

  /** > 0 requests the GPU stack, with the fallbacks a real load applies. */
  gpuLayers?: number
  /**
   * MiniMax compute device, as `config.device` takes it. Without it, `gpuLayers`
   * > 0 projects `auto` (a GPU when one is usable) and anything else `cpu`.
   */
  device?: 'cpu' | 'gpu' | 'auto'
  /** MiniMax full Core ML profile. Projection returns coreml-memory-estimate-unavailable. */
  coremlProfileDir?: string
  coremlComputeUnits?: 'CPU_ONLY' | 'CPU_AND_GPU' | 'CPU_AND_NE' | 'ALL'
  threads?: number
  backendsDir?: string

  /**
   * Longest single generation the projection must accommodate. MiniMax converts
   * it to 25 semantic frames per second, as `run()` does.
   */
  durationSeconds?: number
  /** MiniMax semantic-frame cap. Cannot be combined with `durationSeconds`. Defaults to 300. */
  maxFrames?: number
  /** MiniMax tokenized prompt length: caption, lyrics and template. Defaults to 1024. */
  promptTokens?: number
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

/**
 * `unknown` is a load the fitter cannot size: MiniMax with Core ML stages, or
 * a failed measurement.
 */
export type AudiogenFitStatus = 'fits' | 'does-not-fit' | 'unknown'

export interface AudiogenFitDevice {
  /** The PCI bus ID when the backend reports one, the device name otherwise. */
  id: string
  name: string
  /** Memory the host owns: the host CPU, and a GPU that shares the host's memory. */
  unified: boolean
  /**
   * The load's peak on this device across the pipeline phases. MiniMax keeps
   * its stages resident, so its peak is the steady state of repeated runs.
   */
  usedBytes: number
  freeBytes: number
  totalBytes: number
}

export type AudiogenFitStats = Record<string, never>

export interface AudiogenFitResult {
  status: AudiogenFitStatus
  /**
   * Each device the pipeline uses, then the host CPU, which holds the
   * CPU-placed stages, the mapped weights and the host-side buffers. One CPU
   * row for a load on the CPU. Empty when `unknown`.
   */
  devices: AudiogenFitDevice[]
  stats: AudiogenFitStats
}

export function assessFit(request: AudiogenFitRequest): Promise<AudiogenFitResult>
