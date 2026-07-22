/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
import path = require('bare-path')
/* eslint-enable @typescript-eslint/no-require-imports */

export type AddonConfigValue = string | number | boolean | undefined
export type AddonConfig = Record<string, AddonConfigValue>

export interface SdConfigurationParams {
  path: string
  diffusionModelPath?: string
  highNoiseDiffusionModelPath?: string
  uncondDiffusionModelPath?: string
  clipLPath?: string
  clipGPath?: string
  t5XxlPath?: string
  llmPath?: string
  vaePath?: string
  clipVisionPath?: string
  esrganPath?: string
  audioVaePath?: string
  embeddingsConnectorsPath?: string
  config?: AddonConfig
}

export interface EsrganConfigurationParams {
  esrganPath: string
  config?: AddonConfig
}

export interface SdJobParams {
  [key: string]: unknown
  width?: number
  height?: number
  init_image?: Uint8Array
  init_images?: Uint8Array[]
  control_frames?: Uint8Array[]
}

export interface NativeJobArgs {
  type: 'text'
  input: string
  initImageBuffer?: Uint8Array
  initImageBuffers?: Uint8Array[]
  controlFramesBuffers?: Uint8Array[]
}

export interface NativeUpscaleJobArgs {
  type: 'image'
  input: Uint8Array
  params: string
}

export type SdOutputCallback = (
  addon: SdInterface,
  event: unknown,
  data: unknown,
  error: unknown
) => void

export type EsrganOutputCallback = (
  addon: EsrganUpscalerInterface,
  event: unknown,
  data: unknown,
  error: unknown
) => void

export interface SdBinding {
  createInstance(
    owner: SdInterface,
    configurationParams: SdConfigurationParams,
    outputCallback: SdOutputCallback
  ): object
  activate(handle: unknown): void
  cancel(handle: unknown): Promise<void>
  runJob(handle: unknown, input: NativeJobArgs): Promise<boolean>
  destroyInstance(handle: unknown): void
}

export interface EsrganBinding {
  createUpscalerInstance(
    owner: EsrganUpscalerInterface,
    configurationParams: EsrganConfigurationParams,
    outputCallback: EsrganOutputCallback
  ): object
  activateUpscaler(handle: unknown): void
  cancel(handle: unknown): Promise<void>
  runUpscaleJob(handle: unknown, input: NativeUpscaleJobArgs): Promise<boolean>
  destroyInstance(handle: unknown): void
}

export type MappedAddonEvent =
  | {
      type: 'Error'
      data: unknown
      error: unknown
    }
  | {
      type: 'Output'
      data: Uint8Array | string
      error: null
    }
  | {
      type: 'JobEnded'
      data: Record<string, unknown>
      error: null
    }

/**
 * Normalize a raw native event into `Output` (image bytes or progress
 * tick), `Error`, or `JobEnded`. Returns `null` for unknown shapes
 * (caller logs and skips).
 *
 * Classification priority:
 *   1. Error if rawEvent (string) includes substring "Error"
 *   2. Output if rawData is Uint8Array or string (binary or JSON)
 *   3. JobEnded if rawData is a truthy object (stats payload)
 *   4. Unknown (null) for anything else
 */
export function mapAddonEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown
): MappedAddonEvent | null {
  if (typeof rawEvent === 'string' && rawEvent.includes('Error')) {
    return { type: 'Error', data: rawData, error: rawError }
  }

  if (rawData instanceof Uint8Array || typeof rawData === 'string') {
    return { type: 'Output', data: rawData, error: null }
  }

  if (rawData && typeof rawData === 'object' && !ArrayBuffer.isView(rawData)) {
    const data: Record<string, unknown> = {
      ...(rawData as Record<string, unknown>)
    }
    if (typeof data.backendDevice === 'number') {
      if (data.backendDevice === 0) {
        data.backendDevice = 'cpu'
      } else if (data.backendDevice === 1) {
        data.backendDevice = 'gpu'
      }
    }
    return { type: 'JobEnded', data, error: null }
  }

  return null
}

export interface ImageDimensions {
  width: number
  height: number
}

/**
 * Extract pixel dimensions from a PNG or JPEG buffer without a full decode.
 *
 * PNG: width/height are stored as big-endian uint32 at bytes 16–23 of the IHDR chunk.
 * JPEG: scan for the first SOFx segment (0xFFCx) which stores height at +5 and width at +7.
 *
 * Returns `{ width, height }` or `null` if the format is not recognised.
 */
export function readImageDimensions(buf: Uint8Array): ImageDimensions | null {
  if (!buf || buf.length < 4) return null

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null
    const width = ((buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]) >>> 0
    const height = ((buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]) >>> 0
    return { width, height }
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xff) break
      const marker = buf[i + 1]
      const segmentLength = (buf[i + 2] << 8) | buf[i + 3]
      if (segmentLength < 2) break
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (i + 8 >= buf.length) return null
        const height = (buf[i + 5] << 8) | buf[i + 6]
        const width = (buf[i + 7] << 8) | buf[i + 8]
        return { width, height }
      }
      i += 2 + segmentLength
    }
  }

  return null
}

/**
 * JavaScript wrapper around the native stable-diffusion.cpp addon.
 * Manages the native handle lifecycle and bridges JS ↔ C++.
 */
export class SdInterface {
  private readonly _binding: SdBinding
  private _handle: object | null
  private readonly _spatialAlign: number

  constructor(
    binding: SdBinding,
    configurationParams: SdConfigurationParams,
    outputCallback: SdOutputCallback
  ) {
    this._binding = binding
    this._spatialAlign = configurationParams.embeddingsConnectorsPath ? 32 : 16

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    configurationParams.config = Object.fromEntries(
      Object.entries(configurationParams.config)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )

    this._handle = this._binding.createInstance(this, configurationParams, outputCallback)
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
  async activate(): Promise<void> {
    this._binding.activate(this._handle)
  }

  async cancel(): Promise<void> {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  async runJob<T extends object>(rawParams: T): Promise<boolean> {
    const params = rawParams as T & SdJobParams

    if (params.init_image && Array.isArray(params.init_images) && params.init_images.length > 0) {
      throw new Error('addon.runJob: init_image and init_images are mutually exclusive — pick one.')
    }

    const controlFramesBuffers = Array.isArray(params.control_frames) ? params.control_frames : null

    if (Array.isArray(params.init_images) && params.init_images.length > 0) {
      const initImageBuffers = params.init_images
      const serializable: SdJobParams = { ...params }
      delete serializable.init_images
      delete serializable.control_frames

      this._fillDimsFromImage(serializable, initImageBuffers[0])

      const jobArgs: NativeJobArgs = {
        type: 'text',
        input: JSON.stringify(serializable),
        initImageBuffers
      }
      if (controlFramesBuffers) {
        jobArgs.controlFramesBuffers = controlFramesBuffers
      }
      return this._binding.runJob(this._handle, jobArgs)
    }

    if (params.init_image) {
      const initImageBuffer = params.init_image
      const serializable: SdJobParams = { ...params }
      delete serializable.init_image
      delete serializable.control_frames

      this._fillDimsFromImage(serializable, initImageBuffer)

      const jobArgs: NativeJobArgs = {
        type: 'text',
        input: JSON.stringify(serializable),
        initImageBuffer
      }
      if (controlFramesBuffers) {
        jobArgs.controlFramesBuffers = controlFramesBuffers
      }
      return this._binding.runJob(this._handle, jobArgs)
    }

    const serializable: SdJobParams = { ...params }
    delete serializable.control_frames
    const jobArgs: NativeJobArgs = {
      type: 'text',
      input: JSON.stringify(serializable)
    }
    if (controlFramesBuffers) {
      jobArgs.controlFramesBuffers = controlFramesBuffers
    }
    return this._binding.runJob(this._handle, jobArgs)
  }

  private _fillDimsFromImage(params: SdJobParams, buf: Uint8Array): void {
    if (params.width && params.height) return

    const dimensions = readImageDimensions(buf)
    if (!dimensions) return

    if (!params.width) {
      params.width = Math.ceil(dimensions.width / this._spatialAlign) * this._spatialAlign
    }
    if (!params.height) {
      params.height = Math.ceil(dimensions.height / this._spatialAlign) * this._spatialAlign
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
  async unload(): Promise<void> {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

export class EsrganUpscalerInterface {
  private readonly _binding: EsrganBinding
  private _handle: object | null

  constructor(
    binding: EsrganBinding,
    configurationParams: EsrganConfigurationParams,
    outputCallback: EsrganOutputCallback
  ) {
    this._binding = binding

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    configurationParams.config = Object.fromEntries(
      Object.entries(configurationParams.config)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )

    this._handle = this._binding.createUpscalerInstance(this, configurationParams, outputCallback)
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
  async activate(): Promise<void> {
    this._binding.activateUpscaler(this._handle)
  }

  async cancel(): Promise<void> {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  async runJob(imageBytes: Uint8Array, params: Record<string, unknown>): Promise<boolean> {
    return this._binding.runUpscaleJob(this._handle, {
      type: 'image',
      input: imageBytes,
      params: JSON.stringify(params || {})
    })
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
  async unload(): Promise<void> {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

const cjsExports = {
  SdInterface,
  EsrganUpscalerInterface,
  mapAddonEvent,
  readImageDimensions
}
module.exports = cjsExports
