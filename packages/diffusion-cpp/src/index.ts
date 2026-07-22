/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import path = require('bare-path')
import QvacLogger = require('@qvac/logging')
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
  type QvacResponse
} from '@qvac/infer-base'
import {
  EsrganUpscalerInterface,
  SdInterface,
  mapAddonEvent,
  type EsrganBinding,
  type EsrganConfigurationParams,
  type SdBinding,
  type SdConfigurationParams
} from './addon'
import type VideoStableDiffusionConstructor from './video'

export type NumericLike = number | `${number}`

/**
 * Low-level addon shape exposed by `addon.js` (`SdInterface`). Both image
 * and video modes flow through the same `runJob` entrypoint.
 */
export interface Addon {
  activate(): Promise<void>
  runJob(
    params:
      | (GenerationParams & { mode: 'txt2img' | 'img2img' })
      | { mode: 'txt2vid' | 'img2vid'; [key: string]: unknown }
  ): Promise<boolean>
  cancel(): Promise<void>
  unload(): Promise<void>
}

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

export type RngType = 'cpu' | 'cuda' | 'std_default'

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

export type PredictionType = 'auto' | 'eps' | 'v' | 'edm_v' | 'flow' | 'flux_flow' | 'flux2_flow'

export type LoraApplyMode = 'auto' | 'immediately' | 'at_runtime'

export type CacheMode = 'disabled' | 'easycache' | 'ucache' | 'dbcache' | 'taylorseer' | 'cache-dit'

export interface SdConfig {
  threads?: NumericLike
  device?: 'gpu' | 'cpu'
  'main-gpu'?: number | 'integrated' | 'dedicated'
  type?: WeightType
  rng?: RngType
  sampler_rng?: RngType
  clip_on_cpu?: boolean
  vae_on_cpu?: boolean
  vae_decode_only?: boolean
  vae_tiling?: boolean
  flash_attn?: boolean
  diffusion_fa?: boolean
  mmap?: boolean
  offload_to_cpu?: boolean
  prediction?: PredictionType
  flow_shift?: number
  diffusion_conv_direct?: boolean
  vae_conv_direct?: boolean
  force_sdxl_vae_conv_scale?: boolean
  backendsDir?: string
  tensor_type_rules?: string
  lora_apply_mode?: LoraApplyMode
  upscaler_tile_size?: NumericLike
  upscaler_direct?: boolean
  upscaler_offload_params_to_cpu?: boolean
  upscaler_threads?: NumericLike
  verbosity?: NumericLike
  [key: string]: string | number | boolean | undefined
}

export interface DiffusionFiles {
  model: string
  clipL?: string
  clipG?: string
  t5Xxl?: string
  llm?: string
  vae?: string
  esrgan?: string
  highNoiseDiffusionModel?: string
  uncondModel?: string
}

export interface EsrganFiles {
  esrgan: string
}

export interface EsrganUpscalerConfig {
  backendsDir?: string
  threads?: NumericLike
  upscaler_tile_size?: NumericLike
  upscaler_direct?: boolean
  upscaler_offload_params_to_cpu?: boolean
  upscaler_threads?: NumericLike
  device?: 'cpu' | 'gpu'
  verbosity?: NumericLike
  [key: string]: string | number | boolean | undefined
}

export interface ImgStableDiffusionArgs {
  files: DiffusionFiles
  config?: SdConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
}

export interface EsrganUpscalerArgs {
  files: EsrganFiles
  config?: EsrganUpscalerConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
}

export interface EsrganUpscaleOptions {
  repeats?: number
}

export interface GenerationParams {
  prompt: string
  negative_prompt?: string
  lora?: string
  upscale?: boolean | { repeats?: number }
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  guidance?: number
  sampling_method?: SamplerMethod
  sampler?: SamplerMethod
  scheduler?: ScheduleType
  seed?: number
  batch_count?: number
  vae_tiling?: boolean
  vae_tile_size?: number | string
  vae_tile_overlap?: number
  cache_mode?: CacheMode
  cache_preset?: string
  cache_threshold?: number
  eta?: number
  img_cfg_scale?: number
  clip_skip?: number
  init_image?: Uint8Array
  init_images?: Uint8Array[]
  increase_ref_index?: boolean
  auto_resize_ref_image?: boolean
  strength?: number
}

export interface RuntimeStats {
  modelLoadMs: number
  generationMs: number
  totalGenerationMs: number
  totalWallMs: number
  totalSteps: number
  totalGenerations: number
  totalImages: number
  totalPixels: number
  width: number
  height: number
  seed: number
  conditionerMs: number
  denoiseMs: number
  vaeMs: number
  postProcessMs: number
  stepsPerSecond: number
}

export interface EsrganRuntimeStats {
  modelLoadMs: number
  upscaleMs: number
  totalUpscaleMs: number
  totalWallMs: number
  totalUpscales: number
  totalImages: number
  totalPixels: number
  width: number
  height: number
  repeats: number
  backendDevice?: 'cpu' | 'gpu'
}

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>
type DiffusionAddon = Addon & SdInterface
type UpscalerAddon = EsrganUpscalerInterface

const COMPANION_FILE_KEYS = [
  'clipL',
  'clipG',
  't5Xxl',
  'llm',
  'vae',
  'esrgan',
  'highNoiseDiffusionModel',
  'uncondModel'
] as const

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'
const NATIVE_UPSCALE_REPEATS_MAX = 2_147_483_647

function assertAbsolute(key: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`files.${key} must be an absolute path string`)
  }
  if (!path.isAbsolute(value)) {
    throw new TypeError(`files.${key} must be an absolute path (got: ${value})`)
  }
}

function coerceToUint8(name: string, value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value) && 'BYTES_PER_ELEMENT' in value && value.BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
  ) {
    return new Uint8Array(value)
  }
  throw new TypeError(
    `${name} must be a Uint8Array / Buffer / ArrayBuffer of PNG/JPEG bytes. ` +
      `Got: ${value === null ? 'null' : typeof value}`
  )
}

function normalizeUpscaleRepeats(options: EsrganUpscaleOptions | null | undefined): number {
  if (options == null) return 1
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('upscale options must be an object')
  }

  const repeats = options.repeats == null ? 1 : options.repeats
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new TypeError('upscale.repeats must be a positive integer')
  }
  if (repeats > NATIVE_UPSCALE_REPEATS_MAX) {
    throw new RangeError('upscale.repeats must be a positive integer within the native int range')
  }
  return repeats
}

function loggableError(error: unknown): unknown {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    return message || error
  }
  return error
}

/**
 * Text-to-image and image-to-image generation using stable-diffusion.cpp.
 * Supports SD1.x, SD2.x, SDXL, SD3, FLUX.2 [klein], and Ideogram 4.
 */
export class ImgStableDiffusion {
  addon: Addon | null
  opts: { stats?: boolean }
  logger: QvacLogger
  state: { configLoaded: boolean }

  private readonly _files: DiffusionFiles
  private readonly _config: SdConfig
  private readonly _job: JobHandler
  private readonly _run: RunExclusive
  private _hasActiveResponse: boolean

  constructor({ files, config, logger = null, opts = {} }: ImgStableDiffusionArgs) {
    if (!files || typeof files !== 'object') {
      throw new TypeError('files must be an object containing at least { model }')
    }
    assertAbsolute('model', files.model)
    for (const key of COMPANION_FILE_KEYS) {
      if (files[key] !== undefined) {
        assertAbsolute(key, files[key])
      }
    }
    this._files = files
    this._config = config || {}
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface | undefined)
    this.opts = opts
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })
    this._run = exclusiveRunQueue() as RunExclusive
    this.addon = null
    this._hasActiveResponse = false
    this.state = { configLoaded: false }
  }

  async load(): Promise<void> {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
    })
  }

  private async _load(): Promise<void> {
    this.logger.info('Starting stable-diffusion model load')

    const isSplitLayout =
      !!this._files.llm || !!this._files.t5Xxl || !!this._files.clipL || !!this._files.clipG
    const filesWithClipVision = this._files as DiffusionFiles & {
      clipVision?: string
    }
    const configurationParams: SdConfigurationParams = {
      path: isSplitLayout ? '' : this._files.model,
      diffusionModelPath: isSplitLayout ? this._files.model : '',
      highNoiseDiffusionModelPath: this._files.highNoiseDiffusionModel || '',
      uncondDiffusionModelPath: this._files.uncondModel || '',
      clipLPath: this._files.clipL || '',
      clipGPath: this._files.clipG || '',
      t5XxlPath: this._files.t5Xxl || '',
      llmPath: this._files.llm || '',
      vaePath: this._files.vae || '',
      clipVisionPath: filesWithClipVision.clipVision || '',
      esrganPath: this._files.esrgan || '',
      audioVaePath: '',
      embeddingsConnectorsPath: '',
      config: this._config
    }

    this.logger.info('Creating stable-diffusion addon with configuration:', configurationParams)

    try {
      this.addon = this._createAddon(configurationParams)
      this.logger.info('Activating stable-diffusion addon')
      await this.addon.activate()
    } catch (loadError) {
      this.logger.error('Error during stable-diffusion model load:', loadError)
      try {
        await this.addon?.unload?.()
      } catch {}
      this.addon = null
      throw loadError
    }

    this.logger.info('Stable-diffusion model load completed successfully')
  }

  private _createAddon(configurationParams: SdConfigurationParams): DiffusionAddon {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('./binding') as SdBinding
    return new SdInterface(binding, configurationParams, this._addonOutputCallback.bind(this))
  }

  private _addonOutputCallback(
    _addon: SdInterface,
    event: unknown,
    data: unknown,
    error: unknown
  ): void {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) {
      this.logger.debug(`Unhandled addon event: ${String(event)} (data type: ${typeof data})`)
      return
    }

    if (mapped.type === 'Error') {
      this.logger.error('Job failed with error:', mapped.error)
      this._job.fail(mapped.error as Error)
      return
    }

    if (mapped.type === 'JobEnded') {
      this._job.end(this.opts.stats ? mapped.data : null)
      return
    }

    this._job.output(mapped.data)
  }

  async run(params: GenerationParams): Promise<QvacResponse> {
    return this._run(() => this._runInternal(params))
  }

  private async _runInternal(originalParams: GenerationParams): Promise<QvacResponse> {
    let params = originalParams
    const isSingleImage = params.init_image != null
    const maybeInitImages = Array.isArray(params.init_images) && params.init_images.length > 0
    const paramsWithPrediction = params as GenerationParams & {
      prediction?: string
    }
    const predictionForDefaults =
      paramsWithPrediction.prediction || (this._config && this._config.prediction)
    if ((isSingleImage || maybeInitImages) && predictionForDefaults) {
      params = applyFluxImg2ImgDimDefaults(params, predictionForDefaults, maybeInitImages)
    }

    const alignTo = 8
    const width = params.width
    const height = params.height
    const widthProvided = width != null
    const heightProvided = height != null
    const widthBad =
      widthProvided &&
      (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width % alignTo !== 0)
    const heightBad =
      heightProvided &&
      (typeof height !== 'number' ||
        !Number.isFinite(height) ||
        height <= 0 ||
        height % alignTo !== 0)
    if (widthBad || heightBad) {
      const suggestedWidth =
        typeof width === 'number' && Number.isFinite(width) && width > 0
          ? Math.round(width / alignTo) * alignTo
          : 512
      const suggestedHeight =
        typeof height === 'number' && Number.isFinite(height) && height > 0
          ? Math.round(height / alignTo) * alignTo
          : 512
      throw new Error(
        `width and height must be positive multiples of ${alignTo}. ` +
          `Got: ${width}x${height}. ` +
          `Use ${suggestedWidth}x${suggestedHeight} instead.`
      )
    }

    if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
      throw new TypeError(
        `params.prompt is required and must be a non-empty string. Got: ${typeof params.prompt}`
      )
    }

    if (params.init_images != null && !Array.isArray(params.init_images)) {
      throw new TypeError(
        'init_images must be an Array of Uint8Array; got ' + typeof params.init_images
      )
    }

    const hasInitImages = Array.isArray(params.init_images) && params.init_images.length > 0

    if (params.init_image != null && hasInitImages) {
      throw new Error(
        'init_image and init_images are mutually exclusive — pick one. ' +
          'Use init_images (with FLUX.2) for multi-reference "fusion" mode, ' +
          'or init_image for single-image conditioning (SDEdit / FLUX.2 single-ref).'
      )
    }

    if (params.init_image != null) {
      params.init_image = coerceToUint8('init_image', params.init_image)
    }

    if (
      params.init_images != null &&
      Array.isArray(params.init_images) &&
      params.init_images.length === 0
    ) {
      throw new Error(
        'init_images must not be an empty array. ' +
          'Pass at least one reference image or use init_image for single-image mode.'
      )
    }

    if (hasInitImages && params.init_images) {
      for (let i = 0; i < params.init_images.length; i += 1) {
        let coerced: Uint8Array
        try {
          coerced = coerceToUint8(`init_images[${i}]`, params.init_images[i])
        } catch {
          throw new TypeError(`init_images[${i}] must be a non-empty Uint8Array`)
        }
        if (coerced.length === 0) {
          throw new TypeError(`init_images[${i}] must be a non-empty Uint8Array`)
        }
        params.init_images[i] = coerced
      }
    }

    const prediction = this._config?.prediction
    if (hasInitImages && params.init_images) {
      const isFlux2 = !!this._files?.llm && prediction === 'flux2_flow'
      if (!isFlux2) {
        throw new Error(
          'init_images (multi-reference fusion) requires a FLUX.2 model. ' +
            "Load a FLUX.2 [klein] checkpoint with files.llm set and pass config.prediction: 'flux2_flow'. " +
            'Other architectures (SD1.x, SD2.x, SDXL, SD3, single-image FLUX.2) do not support ' +
            '@image1/@imageN in-context references.'
        )
      }

      if (params.increase_ref_index != null && typeof params.increase_ref_index !== 'boolean') {
        throw new Error(
          'increase_ref_index must be a boolean. Got: ' + typeof params.increase_ref_index
        )
      }

      if (
        params.auto_resize_ref_image != null &&
        typeof params.auto_resize_ref_image !== 'boolean'
      ) {
        throw new Error(
          'auto_resize_ref_image must be a boolean. Got: ' + typeof params.auto_resize_ref_image
        )
      }

      const prompt = typeof params.prompt === 'string' ? params.prompt : ''
      const mentioned: string[] = []
      const missing: string[] = []
      for (let i = 1; i <= params.init_images.length; i += 1) {
        const tag = `@image${i}`
        if (prompt.includes(tag)) mentioned.push(tag)
        else missing.push(tag)
      }
      if (mentioned.length === 0) {
        this.logger.warn(
          'If multiple images have been selected, you need to check the prompt to see ' +
            'if "@image1" and "@imageX" is mentioned at all so that the prompt makes sense. ' +
            `None of @image1…@image${params.init_images.length} were found in the prompt ` +
            '— FLUX2 will run but the references will have no effect.'
        )
      } else if (missing.length > 0) {
        this.logger.warn(
          `Only ${mentioned.join(', ')} found in the prompt; ` +
            `missing ${missing.join(', ')}. Those reference images will be ignored by FLUX2.`
        )
      }

      this.logger.info(
        `stable-diffusion: entering "fusion" mode — ${params.init_images.length} reference images ` +
          '(FLUX2 in-context conditioning via ref_images). ' +
          'Generation will attend to every referenced @imageN in the prompt.'
      )
    }

    if (params.increase_ref_index != null && !hasInitImages) {
      throw new Error(
        'increase_ref_index is only valid with init_images (multi-reference fusion). ' +
          'Your params do not include init_images.'
      )
    }

    if (params.auto_resize_ref_image != null && !params.init_image && !hasInitImages) {
      throw new Error(
        'auto_resize_ref_image can only be used with init_image or init_images. ' +
          'No reference images provided.'
      )
    }

    if (params.lora != null) {
      if (typeof params.lora !== 'string' || params.lora.length === 0) {
        throw new TypeError('params.lora must be a non-empty string')
      }
      if (!path.isAbsolute(params.lora)) {
        throw new TypeError(`params.lora must be an absolute path (got: ${params.lora})`)
      }
    }

    if (params.upscale != null && params.upscale !== false && !this._files.esrgan) {
      throw new Error('ESRGAN upscale requested but files.esrgan was not provided')
    }

    if (params.init_image && this._files.llm) {
      if (prediction !== 'flux2_flow' && prediction !== 'flux_flow') {
        throw new Error(
          'FLUX img2img requires an explicit prediction type in config. ' +
            "Set prediction: 'flux2_flow' (FLUX.2). " +
            'Without this the addon silently falls back to the SD/SDEdit img2img branch ' +
            'instead of the FLUX in-context conditioning path.'
        )
      }
    }

    if (!this.addon) {
      throw new Error('Addon not initialized. Call load() first.')
    }

    const mode = params.init_image || hasInitImages ? 'img2img' : 'txt2img'
    this.logger.info('Starting generation with mode:', mode)

    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const response = this._job.start()

    let accepted: boolean
    try {
      accepted = await this.addon.runJob({ ...params, mode })
    } catch (error) {
      this._job.fail(error as Error)
      throw error
    }

    if (!accepted) {
      this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE))
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this._hasActiveResponse = true
    const finalized = response.await().finally(() => {
      this._hasActiveResponse = false
    })
    finalized.catch((error: unknown) => {
      this.logger?.warn?.('Generation response rejected:', loggableError(error))
    })
    response.await = () => finalized

    this.logger.info('Generation job started successfully')
    return response
  }

  async cancel(): Promise<void> {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  async unload(): Promise<void> {
    return this._run(async () => {
      await this.cancel()
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this._hasActiveResponse = false
      if (this.addon) {
        await this.addon.unload()
        this.addon = null
      }
      this.state.configLoaded = false
    })
  }

  getState(): { configLoaded: boolean } {
    return this.state
  }
}

/**
 * Standalone ESRGAN image upscaling using stable-diffusion.cpp.
 * Accepts encoded PNG/JPEG bytes and emits PNG bytes.
 */
export class EsrganUpscaler {
  opts: { stats?: boolean }
  logger: QvacLogger
  state: { configLoaded: boolean }

  private readonly _files: EsrganFiles
  private readonly _config: EsrganUpscalerConfig
  private readonly _job: JobHandler
  private readonly _run: RunExclusive
  private addon: UpscalerAddon | null
  private _hasActiveResponse: boolean

  constructor({ files, config, logger = null, opts = {} }: EsrganUpscalerArgs) {
    if (!files || typeof files !== 'object') {
      throw new TypeError('files must be an object containing { esrgan }')
    }
    assertAbsolute('esrgan', files.esrgan)

    this._files = files
    this._config = config || {}
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface | undefined)
    this.opts = opts
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })
    this._run = exclusiveRunQueue() as RunExclusive
    this.addon = null
    this._hasActiveResponse = false
    this.state = { configLoaded: false }
  }

  async load(): Promise<void> {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
    })
  }

  private async _load(): Promise<void> {
    this.logger.info('Starting ESRGAN upscaler load')

    const configurationParams: EsrganConfigurationParams = {
      esrganPath: this._files.esrgan,
      config: this._config
    }

    this.logger.info('Creating ESRGAN upscaler addon with configuration:', configurationParams)

    try {
      this.addon = this._createAddon(configurationParams)
      this.logger.info('Activating ESRGAN upscaler addon')
      await this.addon.activate()
    } catch (loadError) {
      this.logger.error('Error during ESRGAN upscaler load:', loadError)
      try {
        await this.addon?.unload?.()
      } catch {}
      this.addon = null
      throw loadError
    }

    this.logger.info('ESRGAN upscaler load completed successfully')
  }

  private _createAddon(configurationParams: EsrganConfigurationParams): UpscalerAddon {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('./binding') as EsrganBinding
    return new EsrganUpscalerInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  private _addonOutputCallback(
    _addon: EsrganUpscalerInterface,
    event: unknown,
    data: unknown,
    error: unknown
  ): void {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) {
      this.logger.debug(`Unhandled addon event: ${String(event)} (data type: ${typeof data})`)
      return
    }

    if (mapped.type === 'Error') {
      this.logger.error('ESRGAN upscale failed with error:', mapped.error)
      this._job.fail(mapped.error as Error)
      return
    }

    if (mapped.type === 'JobEnded') {
      this._job.end(this.opts.stats ? mapped.data : null)
      return
    }

    this._job.output(mapped.data)
  }

  async upscale(imageBytes: Uint8Array, options?: EsrganUpscaleOptions): Promise<QvacResponse> {
    return this._run(() => this._upscaleInternal(imageBytes, options))
  }

  private async _upscaleInternal(
    imageBytes: Uint8Array,
    options?: EsrganUpscaleOptions
  ): Promise<QvacResponse> {
    if (!(imageBytes instanceof Uint8Array)) {
      throw new TypeError('input image must be a Uint8Array')
    }

    const repeats = normalizeUpscaleRepeats(options)

    if (!this.addon) {
      throw new Error('Addon not initialized. Call load() first.')
    }

    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const response = this._job.start()

    let accepted: boolean
    try {
      accepted = await this.addon.runJob(imageBytes, { repeats })
    } catch (error) {
      this._job.fail(error as Error)
      throw error
    }

    if (!accepted) {
      this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE))
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this._hasActiveResponse = true
    const finalized = response.await().finally(() => {
      this._hasActiveResponse = false
    })
    finalized.catch((error: unknown) => {
      this.logger?.warn?.('ESRGAN upscale response rejected:', loggableError(error))
    })
    response.await = () => finalized

    this.logger.info('ESRGAN upscale job started successfully')
    return response
  }

  async cancel(): Promise<void> {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  async unload(): Promise<void> {
    return this._run(async () => {
      await this.cancel()
      if (this._job.active) {
        this._job.fail(new Error('Upscaler was unloaded'))
      }
      this._hasActiveResponse = false
      if (this.addon) {
        await this.addon.unload()
        this.addon = null
      }
      this.state.configLoaded = false
    })
  }

  getState(): { configLoaded: boolean } {
    return this.state
  }
}

export function applyFluxImg2ImgDimDefaults(
  params: GenerationParams,
  prediction: string,
  hasInitImages: boolean
): GenerationParams {
  void hasInitImages
  const isFlux = prediction === 'flux_flow' || prediction === 'flux2_flow'
  if (!isFlux) {
    return params
  }

  if (params.width !== undefined && params.height !== undefined) {
    return params
  }

  return {
    ...params,
    width: params.width !== undefined ? params.width : 1024,
    height: params.height !== undefined ? params.height : 1024
  }
}

export type {
  VideoDiffusionFiles,
  VideoGenerationParams,
  VideoMode,
  VideoRuntimeStats,
  VideoStableDiffusionArgs
} from './video'
export type { QvacResponse }

export type VideoStableDiffusion = InstanceType<typeof VideoStableDiffusionConstructor>

// eslint-disable-next-line @typescript-eslint/no-require-imports -- preserve the CommonJS video subpath export.
export const VideoStableDiffusion = require('./video') as typeof VideoStableDiffusionConstructor

export default ImgStableDiffusion

const cjsExports = ImgStableDiffusion as typeof ImgStableDiffusion & {
  ImgStableDiffusion?: typeof ImgStableDiffusion
  VideoStableDiffusion?: typeof VideoStableDiffusion
  EsrganUpscaler?: typeof EsrganUpscaler
  applyFluxImg2ImgDimDefaults?: typeof applyFluxImg2ImgDimDefaults
}
cjsExports.ImgStableDiffusion = ImgStableDiffusion
cjsExports.VideoStableDiffusion = VideoStableDiffusion
cjsExports.EsrganUpscaler = EsrganUpscaler
cjsExports.applyFluxImg2ImgDimDefaults = applyFluxImg2ImgDimDefaults
module.exports = cjsExports
