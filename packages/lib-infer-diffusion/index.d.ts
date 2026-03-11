import BaseInference from '@qvac/infer-base/WeightsProvider/BaseInference'
import type { QvacResponse } from '@qvac/infer-base'
import type QvacLogger from '@qvac/logging'

export type NumericLike = number | `${number}`

export interface Addon {
  activate(): Promise<void>
  runJob(params: GenerationParams & { mode: 'txt2img' | 'img2img' }): Promise<boolean>
  cancel(): Promise<void>
  unload(): Promise<void>
}

/** Supported diffusion sampling methods */
export type SamplerMethod =
  | 'euler_a'
  | 'euler'
  | 'heun'
  | 'dpm2'
  | 'dpm++_2m'
  | 'dpm++_2m_v2'
  | 'dpm++_2s_a'
  | 'lcm'

/** Supported weight quantization types */
export type WeightType =
  | 'default'
  | 'f32'
  | 'f16'
  | 'q4_0'
  | 'q4_1'
  | 'q5_0'
  | 'q5_1'
  | 'q8_0'

/** Supported RNG types */
export type RngType = 'cuda' | 'cpu'

/** Supported sampling schedules */
export type ScheduleType = 'default' | 'discrete' | 'karras' | 'exponential' | 'ays' | 'gits'

export interface SdConfig {
  /** Number of CPU threads (-1 = auto) */
  threads?: NumericLike
  /** Preferred compute device: 'gpu' (Metal/CUDA/Vulkan) or 'cpu' */
  device?: 'gpu' | 'cpu'
  /** Weight quantization type */
  wtype?: WeightType
  /** RNG type for reproducible generation */
  rng?: RngType
  /** Sampling schedule */
  schedule?: ScheduleType
  /** Run CLIP encoder on CPU even when GPU is available */
  clip_on_cpu?: boolean
  /** Run VAE decoder on CPU even when GPU is available */
  vae_on_cpu?: boolean
  /** Enable VAE tiling to reduce VRAM usage */
  vae_tiling?: boolean
  /** Enable flash attention for memory efficiency */
  flash_attn?: boolean
  /** Logging verbosity: 0=error, 1=warn, 2=info, 3=debug */
  verbosity?: NumericLike
  [key: string]: string | number | boolean | undefined
}

export interface GenerationParams {
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  /** CFG scale (SD1/SD2/SDXL/SD3) */
  cfg_scale?: number
  /** Distilled guidance (FLUX.2) */
  guidance?: number
  /** Sampler name (e.g. 'euler', 'dpm++_2m') */
  sampling_method?: SamplerMethod
  /** Scheduler name */
  scheduler?: ScheduleType
  seed?: number
  batch_count?: number
  /** Enable VAE tiling (for large images) */
  vae_tiling?: boolean
  /** Cache preset: slow/medium/fast/ultra */
  cache_preset?: string
  /** Input image as PNG/JPEG bytes — if provided, runs img2img instead of txt2img */
  init_image?: Uint8Array
  /** img2img denoising strength (0.0–1.0). 0 = keep source, 1 = ignore source */
  strength?: number
}

export interface ImgStableDiffusionArgs {
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
  diskPath?: string
  modelName: string
  /** FLUX.1 / SD3: separate CLIP-L text encoder */
  clipLModel?: string
  /** SDXL / SD3: separate CLIP-G text encoder */
  clipGModel?: string
  /** FLUX.1 / SD3: separate T5-XXL text encoder */
  t5XxlModel?: string
  /** FLUX.2 [klein]: Qwen3 8B text encoder (llm_path) */
  llmModel?: string
  vaeModel?: string
}

export default class ImgStableDiffusion extends BaseInference {
  protected addon: Addon

  constructor(args: ImgStableDiffusionArgs, config: SdConfig)

  _load(): Promise<void>

  load(): Promise<void>

  run(params: GenerationParams): Promise<QvacResponse>

  unload(): Promise<void>

  cancel(): Promise<void>
}

export { QvacResponse }
