import BaseInference, {
  ReportProgressCallback
} from '@qvac/infer-base/WeightsProvider/BaseInference'
import type { QvacResponse } from '@qvac/infer-base'
import type QvacLogger from '@qvac/logging'

export type NumericLike = number | `${number}`

export interface Loader {
  ready(): Promise<void>
  close(): Promise<void>
  getStream(path: string): Promise<AsyncIterable<Uint8Array>>
  download(
    path: string,
    opts: { diskPath: string; progressReporter?: unknown }
  ): Promise<{ await(): Promise<void> }>
  getFileSize?(path: string): Promise<number>
}

export interface Addon {
  activate(): Promise<void>
  runJob(params: GenerationParams): Promise<boolean>
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
  /** Preferred compute device: 'gpu' or 'cpu' */
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
  mode: 'txt2img' | 'img2img' | 'txt2vid'
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  sampler?: SamplerMethod
  seed?: number
  batch_count?: number
  /** img2img only: input image as PNG/JPEG bytes */
  init_image?: Uint8Array
  /** img2img only: denoising strength (0.0–1.0) */
  strength?: number
  /** txt2vid only: number of frames */
  frames?: number
  /** txt2vid only: frames per second */
  fps?: number
}

export interface Txt2ImgParams {
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  sampler?: SamplerMethod
  seed?: number
  batch_count?: number
}

export interface Img2ImgParams extends Txt2ImgParams {
  init_image: Uint8Array
  strength?: number
}

export interface Txt2VidParams {
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  frames?: number
  fps?: number
  steps?: number
  cfg_scale?: number
  sampler?: SamplerMethod
  seed?: number
}

export interface ImgStableDiffusionArgs {
  loader: Loader
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

export interface DownloadWeightsOptions {
  closeLoader?: boolean
}

export interface DownloadResult {
  filePath: string | null
  error: boolean
  completed: boolean
}

export interface StepProgressEvent {
  step: number
  total: number
  elapsed_ms?: number
}

export default class ImgStableDiffusion extends BaseInference {
  protected addon: Addon

  constructor(args: ImgStableDiffusionArgs, config: SdConfig)

  _load(
    closeLoader?: boolean,
    onDownloadProgress?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  load(
    closeLoader?: boolean,
    onDownloadProgress?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  downloadWeights(
    onDownloadProgress?: (progress: Record<string, any>, opts: DownloadWeightsOptions) => any,
    opts?: DownloadWeightsOptions
  ): Promise<Record<string, DownloadResult>>

  txt2img(params: Txt2ImgParams): Promise<QvacResponse>

  img2img(params: Img2ImgParams): Promise<QvacResponse>

  txt2vid(params: Txt2VidParams): Promise<QvacResponse>

  unload(): Promise<void>

  cancel(): Promise<void>
}

export { ReportProgressCallback, QvacResponse }
