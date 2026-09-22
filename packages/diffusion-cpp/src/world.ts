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
  ActionFlag,
  WorldSessionInterface,
  mapAddonEvent,
  type WorldBinding,
  type WorldConfigurationParams
} from './addon'

export { ActionFlag }

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

export type WalkKey = 'W' | 'A' | 'S' | 'D' | 'I' | 'J' | 'K' | 'L'

/** Keyboard bit order used by ABot-World's action adapter. */
const KEY_ORDER: readonly WalkKey[] = ['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L']

/**
 * Keys held during a block: a keys object (`{ W: true }`), an array
 * (`['W', 'J']`), or a raw 8-bit mask — a bitwise OR of `ActionFlag` values
 * (`ActionFlag.W | ActionFlag.L`; bit 0..7 = W,A,S,D,I,J,K,L).
 */
export type WalkKeys = number | readonly string[] | Readonly<Record<string, unknown>>

/** File paths for an ABot-World walk session. All paths must be absolute. */
export interface WorldFiles {
  /** ABot-World DiT GGUF (F16 or Q8_0). */
  model: string
  /** taew2_2 GGUF (streaming pixel decoder). */
  taehv: string
  /**
   * Scene pack safetensors (prompt embeds, first-frame latents, reference
   * latents). Consumed by walks; produced by `createScene()`.
   */
  scene: string
}

export interface WorldConfig {
  threads?: number
  seed?: number
  backend?: string
  /** Latent frames the DiT denoises per step. 0 = model default (3). */
  numFramePerBlock?: number
  /** History attention window in latent frames. 0 = engine default (8). */
  localAttnSize?: number
  offloadParamsToCpu?: boolean
  backendsDir?: string
  /**
   * Frame encoding: 0 = lossless PNG; 1..100 = JPEG at that quality on the
   * standard JPEG scale (higher = better quality / larger frames; 85 is a
   * good remote-streaming value).
   */
  frameJpegQuality?: number
  /**
   * Per-layer history KV cache (~3.7x fewer frame-passes per block). The
   * engine validates it against localAttnSize at load and fails fast on a
   * window the compiled KV ring cannot hold.
   */
  kvCache?: boolean
  /** Per-stage timing logs from the native session. */
  profile?: boolean
  [key: string]: string | number | boolean | undefined
}

export interface WorldStableDiffusionArgs {
  files: WorldFiles
  config?: WorldConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
}

export interface WorldSceneParams {
  /** Scene prompt (encoded verbatim; reference demos prefix "| unknown | "). */
  prompt: string
  /** First frame, PNG or JPEG bytes. */
  image: Uint8Array
  /** umT5-XXL model path (absolute). */
  t5: string
  /** Wan2.2 VAE model path (absolute). */
  vae: string
  /** Destination scene pack path (absolute). */
  output: string
  /** Multiples of 32. Default 832. */
  width?: number
  /** Multiples of 32. Default 480. */
  height?: number
}

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>

function assertAbsolute(key: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`files.${key} must be an absolute path string`)
  }
  if (!path.isAbsolute(value)) {
    throw new TypeError(`files.${key} must be an absolute path (got: ${value})`)
  }
}

/**
 * Convert a keys object ({ W: true, J: true }) or an array (['W', 'J']) into
 * the 8-bit action mask the native session expects. Numbers pass through.
 */
function toActionMask(keys: WalkKeys): number {
  if (typeof keys === 'number') {
    if (!Number.isInteger(keys) || keys < 0 || keys > 255) {
      throw new TypeError(`action mask must be an integer in [0, 255], got: ${keys}`)
    }
    return keys
  }
  let mask = 0
  const set = Array.isArray(keys)
    ? keys.map((key) => String(key).toUpperCase())
    : Object.entries(keys || {})
        .filter(([, value]) => Boolean(value))
        .map(([key]) => key.toUpperCase())
  for (const key of set) {
    const bit = KEY_ORDER.indexOf(key as WalkKey)
    if (bit === -1) {
      throw new TypeError(`unknown walk key '${key}' (valid: ${KEY_ORDER.join(', ')})`)
    }
    mask |= 1 << bit
  }
  return mask
}

/**
 * ABot-World interactive walk session.
 *
 * ABot-World is a causal world model: it generates video block-by-block under
 * per-block keyboard actions instead of one batch call. A session holds the
 * DiT + taehv decoder and a fixed scene pack; each `step()` generates the next
 * block of the walk and streams its decoded frames as PNG byte arrays (or
 * JPEG when `config.frameJpegQuality` is 1..100).
 *
 * ```js
 * const WorldStableDiffusion = require('@qvac/diffusion-cpp/world')
 * const world = new WorldStableDiffusion({
 *   files: { model: ditGguf, taehv: taehvGguf, scene: scenePack },
 *   config: { threads: 8, seed: 42, kvCache: true }
 * })
 * await world.load()
 * const response = await world.step({ W: true }) // walk forward one block
 * await response.onUpdate((data) => {
 *   if (data instanceof Uint8Array) framePngs.push(data)
 * }).await()
 * await world.unload()
 * ```
 */
export default class WorldStableDiffusion {
  opts: { stats?: boolean }
  logger: QvacLogger
  state: { configLoaded: boolean }

  private readonly _files: WorldFiles
  private readonly _config: WorldConfig
  private readonly _job: JobHandler
  private readonly _run: RunExclusive
  private addon: WorldSessionInterface | null
  private _hasActiveResponse: boolean

  constructor({ files, config, logger = null, opts = {} }: WorldStableDiffusionArgs) {
    if (!files || typeof files !== 'object') {
      throw new TypeError('files must be an object: { model, taehv, scene }')
    }
    assertAbsolute('model', files.model)
    assertAbsolute('taehv', files.taehv)
    assertAbsolute('scene', files.scene)

    const jpegQuality = config?.frameJpegQuality
    if (
      jpegQuality !== undefined &&
      (!Number.isInteger(jpegQuality) || jpegQuality < 0 || jpegQuality > 100)
    ) {
      // catch it here: out of range only surfaces natively as an opaque
      // "failed to encode walk frame" at step time
      throw new TypeError(
        `config.frameJpegQuality must be an integer in [0, 100] (0 = PNG), got: ${String(jpegQuality)}`
      )
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
    this.logger.info('Starting ABot-World walk session load')

    const configurationParams: WorldConfigurationParams = {
      diffusionModelPath: this._files.model,
      taehvPath: this._files.taehv,
      scenePath: this._files.scene,
      config: this._config
    }

    try {
      // createScene() may have created the addon on demand already; reuse it
      // instead of constructing a second instance - the orphaned native
      // instance would keep its job-runner thread and JS callback alive,
      // preventing the process from ever draining its event loop.
      if (!this.addon) {
        this.addon = this._createAddon(configurationParams)
      }
      this.logger.info('Activating ABot-World walk session (loads DiT + taehv + scene)')
      await this.addon.activate()
    } catch (loadError) {
      this.logger.error('Error during ABot-World session load:', loadError)
      try {
        await this.addon?.unload?.()
      } catch {}
      this.addon = null
      throw loadError
    }

    this.logger.info('ABot-World walk session ready')
  }

  private _createAddon(configurationParams: WorldConfigurationParams): WorldSessionInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('./binding') as WorldBinding
    return new WorldSessionInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  private _addonOutputCallback(
    addon: WorldSessionInterface,
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
      this.logger.error('Walk step failed with error:', mapped.error)
      this._job.fail(mapped.error as Error)
      return
    }

    if (mapped.type === 'JobEnded') {
      this._job.end(this.opts.stats ? mapped.data : null)
      return
    }

    if (mapped.type === 'Output') {
      this._job.output(mapped.data)
    }
  }

  /**
   * Generate the next block of the walk.
   *
   * Output stream (via `QvacResponse.onUpdate(data)`):
   *   - `Uint8Array` — one decoded RGB frame as PNG (several per block), or
   *     JPEG when `config.frameJpegQuality` is 1..100
   *   - `string`     — progress JSON `{"step":N,"frames":M,"elapsed_ms":T}`
   *
   * @param keys - Keys held during this block: a keys object `{ W: true }`,
   *        an array `['W']`, or a raw 8-bit mask built from `ActionFlag`
   *        values (bit 0..7 = W,A,S,D,I,J,K,L).
   *        Omit for no keys (idle).
   */
  async step(keys: WalkKeys = 0): Promise<QvacResponse> {
    return this._run(() => this._stepInternal(keys))
  }

  /**
   * Create a scene pack natively: umT5-XXL encodes the prompt, the Wan2.2 VAE
   * encodes the first-frame image (cover-scaled and center-cropped to
   * width x height), reference slots are zero-filled, and the pack is written
   * to `output` — loadable via `files.scene` for a walk session. Standalone:
   * works before load() (the session loads its own encoders per job and
   * frees them after).
   *
   * Output stream (via `QvacResponse.onUpdate(data)`):
   *   - `string` — completion JSON `{"scene":"<path>","elapsed_ms":T}`
   */
  async createScene(params: WorldSceneParams): Promise<QvacResponse> {
    return this._run(() => this._createSceneInternal(params))
  }

  private async _createSceneInternal(params: WorldSceneParams): Promise<QvacResponse> {
    if (!params || typeof params !== 'object') {
      throw new TypeError('createScene(params): params must be an object')
    }
    for (const key of ['t5', 'vae', 'output'] as const) {
      assertAbsolute(key, params[key])
    }
    if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
      throw new TypeError('params.prompt must be a non-empty string')
    }
    if (!(params.image instanceof Uint8Array) || params.image.length === 0) {
      throw new TypeError('params.image must be a non-empty Uint8Array (PNG/JPEG bytes)')
    }
    const width = params.width ?? 832
    const height = params.height ?? 480
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width % 32 !== 0 ||
      height % 32 !== 0
    ) {
      throw new Error(
        `scene width/height must be positive multiples of 32 (got ${width}x${height})`
      )
    }
    if (!this.addon) {
      // scene creation is standalone — create the native instance on demand
      this.addon = this._createAddon({
        diffusionModelPath: this._files.model,
        taehvPath: this._files.taehv,
        scenePath: this._files.scene,
        config: this._config
      })
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const response = this._job.start()

    let accepted: boolean
    try {
      accepted = await this.addon.runSceneCreate(
        {
          prompt: params.prompt,
          width,
          height,
          t5Path: params.t5,
          vaePath: params.vae,
          outputPath: params.output
        },
        params.image
      )
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
      this.logger?.warn?.('Scene creation response rejected:', error)
    })
    response.await = () => finalized

    return response
  }

  private async _stepInternal(keys: WalkKeys): Promise<QvacResponse> {
    if (!this.state.configLoaded || !this.addon) {
      throw new Error('WorldStableDiffusion.step() called before load()')
    }

    const actionMask = toActionMask(keys)

    // Two-level concurrency model — same as VideoStableDiffusion._runInternal:
    // `_run` serializes the synchronous dispatch; `_hasActiveResponse` rejects
    // a second step while the previous block's frames are still streaming.
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const response = this._job.start()

    let accepted: boolean
    try {
      accepted = await this.addon.runStep(actionMask)
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
      this.logger?.warn?.('Walk step response rejected:', error)
    })
    response.await = () => finalized

    return response
  }

  async cancel(): Promise<void> {
    await this.addon?.cancel()
  }

  async unload(): Promise<void> {
    return this._run(async () => {
      if (!this.addon) return
      this.logger.info('Unloading ABot-World walk session')
      // Same teardown order as StableDiffusion.unload(): cancel first, then
      // explicitly fail a job the scheduler admitted but never started (its
      // teardown emits no terminal event for that case) so the QvacResponse
      // settles and the busy guard is released instead of bricking the
      // instance.
      await this.cancel()
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this._hasActiveResponse = false
      await this.addon.unload()
      this.addon = null
      this.state.configLoaded = false
    })
  }

  getState(): { configLoaded: boolean } {
    return { ...this.state }
  }
}

const cjsExports = Object.assign(WorldStableDiffusion, { toActionMask, KEY_ORDER, ActionFlag })
module.exports = cjsExports
