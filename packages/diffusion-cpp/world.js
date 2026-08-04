'use strict'

const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { WorldSessionInterface, mapAddonEvent } = require('./addon')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

// Keyboard bit order used by ABot-World's action adapter.
const KEY_ORDER = ['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L']

function assertAbsolute(key, value) {
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
 * @param {number|object|string[]} keys
 * @returns {number}
 */
function toActionMask(keys) {
  if (typeof keys === 'number') {
    if (!Number.isInteger(keys) || keys < 0 || keys > 255) {
      throw new TypeError(`action mask must be an integer in [0, 255], got: ${keys}`)
    }
    return keys
  }
  let mask = 0
  const set = Array.isArray(keys)
    ? keys.map((k) => String(k).toUpperCase())
    : Object.entries(keys || {})
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k.toUpperCase())
  for (const key of set) {
    const bit = KEY_ORDER.indexOf(key)
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
 * block of the walk and streams its decoded frames as PNG byte arrays.
 *
 * ```js
 * const WorldStableDiffusion = require('@qvac/diffusion-cpp/world')
 * const world = new WorldStableDiffusion({
 *   files: { model: ditGguf, taehv: taehvGguf, scene: scenePack },
 *   config: { threads: 8, seed: 42 }
 * })
 * await world.load()
 * const response = await world.step({ W: true }) // walk forward one block
 * await response.onUpdate((data) => {
 *   if (data instanceof Uint8Array) framePngs.push(data)
 * }).await()
 * await world.unload()
 * ```
 */
class WorldStableDiffusion {
  /**
   * @param {object} args
   * @param {object} args.files
   * @param {string} args.files.model - ABot-World DiT GGUF (F16 or Q8_0). Absolute path.
   * @param {string} args.files.taehv - taew2_2 GGUF (streaming pixel decoder). Absolute path.
   * @param {string} args.files.scene - Scene pack safetensors (prompt embeds,
   *        first-frame latents, reference latents). Absolute path.
   * @param {object} [args.config] - Session config: threads, seed, backend,
   *        numFramePerBlock, localAttnSize, offloadParamsToCpu, backendsDir,
   *        frameJpegQuality (0 = PNG frames, 1..100 = JPEG at that quality),
   *        kvCache (per-layer history KV cache, ~3.7x fewer frame-passes per
   *        block; validated against localAttnSize at load), profile (native
   *        per-stage timing logs).
   * @param {object} [args.logger] - Structured logger for JS wrapper logs.
   * @param {object} [args.opts] - Options ({ stats: true } to receive runtime
   *        stats on stream end).
   */
  constructor({ files, config, logger = null, opts = {} }) {
    if (!files || typeof files !== 'object') {
      throw new TypeError('files must be an object: { model, taehv, scene }')
    }
    assertAbsolute('model', files.model)
    assertAbsolute('taehv', files.taehv)
    assertAbsolute('scene', files.scene)

    this._files = files
    this._config = config || {}
    this.logger = new QvacLogger(logger)
    this.opts = opts

    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })
    this._run = exclusiveRunQueue()
    this.addon = null
    this._hasActiveResponse = false
    this.state = { configLoaded: false }
  }

  async load() {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
    })
  }

  async _load() {
    this.logger.info('Starting ABot-World walk session load')

    const configurationParams = {
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
      } catch (_) {}
      this.addon = null
      throw loadError
    }

    this.logger.info('ABot-World walk session ready')
  }

  _createAddon(configurationParams) {
    const binding = require('./binding')
    return new WorldSessionInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _addonOutputCallback(addon, event, data, error) {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) {
      this.logger.debug(`Unhandled addon event: ${event} (data type: ${typeof data})`)
      return
    }

    if (mapped.type === 'Error') {
      this.logger.error('Walk step failed with error:', mapped.error)
      this._job.fail(mapped.error)
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
   *   - `Uint8Array` — one decoded RGB frame as PNG (several per block)
   *   - `string`     — progress JSON `{"step":N,"frames":M,"elapsed_ms":T}`
   *
   * @param {number|object|string[]} [keys] - Keys held during this block:
   *        a keys object `{ W: true }`, an array `['W']`, or a raw 8-bit
   *        mask (bit 0..7 = W,A,S,D,I,J,K,L). Omit for no keys (idle).
   * @returns {Promise<QvacResponse>}
   */
  async step(keys = 0) {
    return this._run(() => this._stepInternal(keys))
  }

  /**
   * Create a scene pack natively: umT5-XXL encodes the prompt, the Wan2.2 VAE
   * encodes the first-frame image (cover-scaled and center-cropped to
   * width x height), reference slots are zero-filled, and the pack is written
   * to `output` — loadable via `files.scene` for a walk session. Standalone:
   * works before load() (it loads its own encoders and frees them after).
   *
   * Output stream (via `QvacResponse.onUpdate(data)`):
   *   - `string` — completion JSON `{"scene":"<path>","elapsed_ms":T}`
   *
   * @param {object} params
   * @param {string} params.prompt   - Scene prompt (encoded verbatim; reference
   *        demos prefix "| unknown | ").
   * @param {Uint8Array} params.image - First frame, PNG or JPEG bytes.
   * @param {string} params.t5       - umT5-XXL model path (absolute).
   * @param {string} params.vae      - Wan2.2 VAE model path (absolute).
   * @param {string} params.output   - Destination scene pack path (absolute).
   * @param {number} [params.width=832]  - Multiples of 32.
   * @param {number} [params.height=480]
   * @returns {Promise<QvacResponse>}
   */
  async createScene(params) {
    return this._run(() => this._createSceneInternal(params))
  }

  async _createSceneInternal(params) {
    if (!params || typeof params !== 'object') {
      throw new TypeError('createScene(params): params must be an object')
    }
    for (const key of ['t5', 'vae', 'output']) {
      assertAbsolute(key, params[key])
    }
    if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
      throw new TypeError('params.prompt must be a non-empty string')
    }
    if (!(params.image instanceof Uint8Array) || params.image.length === 0) {
      throw new TypeError('params.image must be a non-empty Uint8Array (PNG/JPEG bytes)')
    }
    const width = params.width || 832
    const height = params.height || 480
    if (width % 32 !== 0 || height % 32 !== 0) {
      throw new Error(`scene width/height must be multiples of 32 (got ${width}x${height})`)
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

    let accepted
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
      this._job.fail(error)
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
    finalized.catch((err) => {
      this.logger?.warn?.('Scene creation response rejected:', err?.message || err)
    })
    response.await = () => finalized

    return response
  }

  async _stepInternal(keys) {
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

    let accepted
    try {
      accepted = await this.addon.runStep(actionMask)
    } catch (error) {
      this._job.fail(error)
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
    finalized.catch((err) => {
      this.logger?.warn?.('Walk step response rejected:', err?.message || err)
    })
    response.await = () => finalized

    return response
  }

  async cancel() {
    await this.addon?.cancel()
  }

  async unload() {
    return this._run(async () => {
      if (!this.addon) return
      this.logger.info('Unloading ABot-World walk session')
      await this.addon.unload()
      this.addon = null
      this.state.configLoaded = false
    })
  }

  getState() {
    return { ...this.state }
  }
}

module.exports = WorldStableDiffusion
module.exports.toActionMask = toActionMask
module.exports.KEY_ORDER = KEY_ORDER
