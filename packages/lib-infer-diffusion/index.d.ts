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
  | 'euler'
  | 'euler_a'
  | 'heun'
  | 'dpm2'
  | 'dpm++2m'
  | 'dpm++2mv2'
  | 'dpm++2s_a'
  | 'lcm'
  | 'ipndm'
  | 'ipndm_v'
  | 'ddim_trailing'
  | 'tcd'
  | 'res_multistep'
  | 'res_2s'

/** Supported weight quantization types */
export type WeightType =
  | 'auto'
  | 'f32'
  | 'f16'
  | 'bf16'
  | 'q2_k'
  | 'q3_k'
  | 'q4_0'
  | 'q4_1'
  | 'q4_k'
  | 'q5_0'
  | 'q5_1'
  | 'q5_k'
  | 'q6_k'
  | 'q8_0'

/** Supported RNG types */
export type RngType = 'cpu' | 'cuda' | 'std_default'

/** Supported sampling schedules */
export type ScheduleType =
  | 'discrete'
  | 'karras'
  | 'exponential'
  | 'ays'
  | 'gits'
  | 'sgm_uniform'
  | 'simple'
  | 'lcm'
  | 'smoothstep'
  | 'kl_optimal'
  | 'bong_tangent'

/** Supported noise prediction types */
export type PredictionType = 'auto' | 'eps' | 'v' | 'edm_v' | 'flow' | 'flux_flow' | 'flux2_flow'

/** LoRA application mode */
export type LoraApplyMode = 'auto' | 'immediately' | 'at_runtime'

/** Step-caching algorithm */
export type CacheMode = 'disabled' | 'easycache' | 'ucache' | 'dbcache' | 'taylorseer' | 'cache-dit'

export interface SdConfig {
  /** Number of CPU threads (-1 = auto) */
  threads?: NumericLike
  /** Preferred compute device: 'gpu' (Metal/Vulkan) or 'cpu' */
  device?: 'gpu' | 'cpu'
  /** Weight quantization type */
  type?: WeightType
  /** RNG type for reproducible generation */
  rng?: RngType
  /** RNG type for the sampler (separate from context RNG) */
  sampler_rng?: RngType
  /** Run CLIP encoder on CPU even when GPU is available */
  clip_on_cpu?: boolean
  /** Run VAE decoder on CPU even when GPU is available */
  vae_on_cpu?: boolean
  /** Enable VAE tiling to reduce VRAM usage */
  vae_tiling?: boolean
  /** Enable flash attention for memory efficiency */
  flash_attn?: boolean
  /** Enable flash attention for diffusion model specifically */
  diffusion_fa?: boolean
  /** Use memory-mapped model loading */
  mmap?: boolean
  /** Offload model weights to CPU when not in use */
  offload_to_cpu?: boolean
  /**
   * Noise prediction type override. Auto-detected from model for txt2img, but
   * **required** for FLUX img2img: the addon's branch selection relies on this
   * value to choose the FLUX in-context conditioning path vs. SDEdit. Set
   * `'flux2_flow'` for FLUX.2 when using `init_image`.
   */
  prediction?: PredictionType
  /** Flow-matching guidance shift */
  flow_shift?: number
  /** Use direct convolution in diffusion model */
  diffusion_conv_direct?: boolean
  /** Use direct convolution in VAE */
  vae_conv_direct?: boolean
  /** Force SDXL VAE conv scale factor */
  force_sdxl_vae_conv_scale?: boolean
  /** Custom backends directory path (defaults to prebuilds/) */
  backendsDir?: string
  /** Custom tensor type rules string */
  tensor_type_rules?: string
  /** LoRA application mode */
  lora_apply_mode?: LoraApplyMode
  /** Logging verbosity: 0=error, 1=warn, 2=info, 3=debug */
  verbosity?: NumericLike
  [key: string]: string | number | boolean | undefined
}

export interface DiffusionFiles {
  /** Absolute path to main model weights */
  model: string
  /** SD3: absolute path to CLIP-L text encoder */
  clipL?: string
  /** SDXL / SD3: absolute path to CLIP-G text encoder */
  clipG?: string
  /** SD3: absolute path to T5-XXL text encoder */
  t5Xxl?: string
  /** FLUX.2 [klein]: absolute path to Qwen3 4B text encoder (llm_path) */
  llm?: string
  /** Absolute path to VAE file */
  vae?: string
}

export interface ImgStableDiffusionArgs {
  files: DiffusionFiles
  /**
   * Native backend configuration. Optional — when omitted, the addon
   * forwards an empty config object and the C++ layer falls back to
   * stable-diffusion.cpp defaults for every parameter.
   */
  config?: SdConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
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
  /** Sampler name (e.g. 'euler', 'dpm++2m') */
  sampling_method?: SamplerMethod
  /** Alias for sampling_method — accepted by the C++ layer */
  sampler?: SamplerMethod
  /** Scheduler name */
  scheduler?: ScheduleType
  seed?: number
  batch_count?: number
  /** Enable VAE tiling (for large images) */
  vae_tiling?: boolean
  /** VAE tile dimensions — integer or 'WxH' string (e.g. '512x512') */
  vae_tile_size?: number | string
  /** VAE tile overlap fraction (0.0–1.0) */
  vae_tile_overlap?: number
  /** Step-caching algorithm */
  cache_mode?: CacheMode
  /** Cache preset: slow/medium/fast/ultra (shorthand for cache_mode + threshold) */
  cache_preset?: string
  /** Direct cache reuse threshold override (0 = library default) */
  cache_threshold?: number
  /** Stochasticity parameter for DDIM/TCD samplers */
  eta?: number
  /** Image CFG scale for img2img/inpaint (-1 = use cfg_scale) */
  img_cfg_scale?: number
  /** Skip last N CLIP encoder layers (SD1.x/SD2.x) */
  clip_skip?: number
  /** Input image as PNG/JPEG bytes for img2img. */
  init_image?: Uint8Array
  /**
   * img2img denoising strength (0.0 to 1.0). 0 = keep source, 1 = ignore source.
   * SD1.x/SD2.x/SDXL/SD3 only. FLUX.2 ignores `strength` and routes `init_image`
   * through in-context conditioning instead.
   */
  strength?: number
}

/**
 * Shape of the stats object emitted on the 'stats' event of a QvacResponse.
 *
 * All time values are in milliseconds. Cumulative fields (totalGenerationMs,
 * totalWallMs, totalSteps, totalGenerations, totalImages, totalPixels) accumulate
 * across the lifetime of the model instance; per-job fields (generationMs, width,
 * height, seed) reflect only the most recent generation.
 *
 * Derivable rates (stepsPerSecond, msPerStep, megapixelsPerSecond) are intentionally
 * omitted — callers can compute them from the primitives provided:
 *   stepsPerSecond    = totalSteps  / (totalWallMs / 1000)
 *   msPerStep         = totalWallMs / totalSteps
 *   megapixelsPerSec  = (totalPixels / 1e6) / (totalWallMs / 1000)
 */
export interface RuntimeStats {
  /** Wall time to load the model weights (ms) */
  modelLoadMs: number
  /** Wall time for the most recent generation job (ms) */
  generationMs: number
  /** Cumulative generation time across all jobs (ms) */
  totalGenerationMs: number
  /** Cumulative wall time across all jobs (ms) */
  totalWallMs: number
  /** Cumulative diffusion steps across all jobs */
  totalSteps: number
  /** Cumulative number of generation calls */
  totalGenerations: number
  /** Cumulative number of images produced */
  totalImages: number
  /** Cumulative number of pixels produced */
  totalPixels: number
  /** Width of the most recent generated image (px) */
  width: number
  /** Height of the most recent generated image (px) */
  height: number
  /** Seed used for the most recent generation */
  seed: number
}

export default class ImgStableDiffusion {
  protected addon: Addon | null
  opts: { stats?: boolean }
  logger: QvacLogger
  state: { configLoaded: boolean }

  constructor(args: ImgStableDiffusionArgs)

  load(): Promise<void>

  run(params: GenerationParams): Promise<QvacResponse>

  unload(): Promise<void>

  cancel(): Promise<void>

  getState(): { configLoaded: boolean }
}

export { QvacResponse, RuntimeStats }
