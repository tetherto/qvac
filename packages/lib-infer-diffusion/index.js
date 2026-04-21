'use strict'

const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { SdInterface, mapAddonEvent } = require('./addon')

const COMPANION_FILE_KEYS = ['clipL', 'clipG', 't5Xxl', 'llm', 'vae']

function assertAbsolute (key, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`files.${key} must be an absolute path string`)
  }
  if (!path.isAbsolute(value)) {
    throw new TypeError(`files.${key} must be an absolute path (got: ${value})`)
  }
}

const LOG_METHODS = ['error', 'warn', 'info', 'debug']

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * Text-to-image and image-to-image generation using stable-diffusion.cpp.
 * Supports SD1.x, SD2.x, SDXL, SD3, and FLUX.2 [klein].
 */
class ImgStableDiffusion {
  /**
   * @param {object} args
   * @param {object} args.files - Absolute file paths for model components
   * @param {string} args.files.model - Main model weights (absolute path)
   * @param {string} [args.files.clipL] - CLIP-L text encoder (SD3, absolute path)
   * @param {string} [args.files.clipG] - CLIP-G text encoder (SDXL / SD3, absolute path)
   * @param {string} [args.files.t5Xxl] - T5-XXL text encoder (SD3, absolute path)
   * @param {string} [args.files.llm] - LLM text encoder (FLUX.2 klein, absolute path)
   * @param {string} [args.files.vae] - VAE file (absolute path)
   * @param {object} [args.config] - SD context configuration (threads, device, type, etc.).
   *   Optional — when omitted, the addon forwards an empty config and the C++ layer falls
   *   back to stable-diffusion.cpp defaults for every parameter.
   * @param {object} [args.logger] - Structured logger
   * @param {object} [args.opts] - Optional inference options
   */
  constructor ({ files, config, logger = null, opts = {} }) {
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
    this.logger = new QvacLogger(logger)
    this.opts = opts
    // Lazy deref + optional chain: safe before `_load()` and after `unload()`.
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })
    this._run = exclusiveRunQueue()
    this.addon = null
    this._hasActiveResponse = false
    this._binding = null
    this._nativeLoggerActive = false
    this.state = { configLoaded: false }
  }

  async load () {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
    })
  }

  async _load () {
    this.logger.info('Starting stable-diffusion model load')

    // Route the primary model file to the correct stable-diffusion.cpp param:
    //   path              — all-in-one checkpoints (SD1.x, SD2.x, SDXL, SD3 all-in-one GGUF)
    //   diffusionModelPath — standalone diffusion weights requiring separate encoders
    //                        (FLUX.2 klein → llm, SD3 pure GGUF → t5Xxl + clipL + clipG,
    //                         FLUX.1 → t5Xxl + clipL, etc.)
    // Any caller-supplied separate encoder implies the primary file is the standalone
    // diffusion model, not an all-in-one checkpoint.
    const isSplitLayout = !!this._files.llm || !!this._files.t5Xxl ||
      !!this._files.clipL || !!this._files.clipG
    const configurationParams = {
      path: isSplitLayout ? '' : this._files.model,
      diffusionModelPath: isSplitLayout ? this._files.model : '',
      clipLPath: this._files.clipL || '',
      clipGPath: this._files.clipG || '',
      t5XxlPath: this._files.t5Xxl || '',
      llmPath: this._files.llm || '',
      vaePath: this._files.vae || '',
      config: this._config
    }

    this.logger.info('Creating stable-diffusion addon with configuration:', configurationParams)

    try {
      this.addon = this._createAddon(configurationParams)
      this.logger.info('Activating stable-diffusion addon')
      await this.addon.activate()
    } catch (loadError) {
      this.logger.error('Error during stable-diffusion model load:', loadError)
      // Best-effort cleanup of the partially-initialized addon so a subsequent
      // load() does not leak a zombie native instance.
      try { await this.addon?.unload?.() } catch (_) {}
      this.addon = null
      this._releaseNativeLogger()
      throw loadError
    }

    this.logger.info('Stable-diffusion model load completed successfully')
  }

  /**
   * @param {object} configurationParams
   * @returns {SdInterface}
   */
  _createAddon (configurationParams) {
    this._binding = require('./binding')
    this._connectNativeLogger()
    return new SdInterface(
      this._binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _connectNativeLogger () {
    if (!this._binding || !this.logger) return
    try {
      this._binding.setLogger((priority, message) => {
        const method = LOG_METHODS[priority] || 'info'
        if (typeof this.logger[method] === 'function') {
          this.logger[method](`[C++] ${message}`)
        }
      })
      this._nativeLoggerActive = true
    } catch (err) {
      this.logger.warn('Failed to connect native logger:', err.message)
    }
  }

  _releaseNativeLogger () {
    if (!this._nativeLoggerActive || !this._binding) return
    try {
      this._binding.releaseLogger()
    } catch (_) {}
    this._nativeLoggerActive = false
  }

  _addonOutputCallback (addon, event, data, error) {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) {
      // Unknown event/data combination — log it instead of feeding null/undefined
      // into the active response output stream. The native layer is expected to
      // emit only the shapes handled above; reaching this branch indicates a
      // native-layer bug worth surfacing.
      this.logger.debug(`Unhandled addon event: ${event} (data type: ${typeof data})`)
      return
    }

    if (mapped.type === 'Error') {
      this.logger.error('Job failed with error:', mapped.error)
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
   * Generate an image from a text prompt, or transform an input image with a prompt.
   *
   * Mode is determined automatically:
   *   - If `params.init_image` is provided → img2img
   *   - Otherwise → txt2img
   *
   * img2img routing depends on the model architecture:
   *
   *   FLUX2 (prediction: 'flux2_flow'):
   *     Uses in-context conditioning (ref_images). The input image is VAE-encoded
   *     into separate latent tokens that the FLUX transformer attends to via joint
   *     attention with distinct RoPE positions. The target starts from pure noise,
   *     preserving features (skin tone, structure, etc.).
   *
   *   SD1.x / SD2.x / SDXL / SD3 (all other prediction types):
   *     Uses traditional SDEdit (init_image). The input image is noised to the
   *     level set by `strength`, then denoised for the remaining steps. Lower
   *     strength = closer to the original image.
   *
   * Returns a QvacResponse that streams two types of updates:
   *   - Uint8Array  — PNG-encoded output image (one per batch_count)
   *   - string      — JSON step-progress tick: {"step":N,"total":M,"elapsed_ms":T}
   *
   * @param {object} params
   * @param {string} params.prompt                  - Text prompt
   * @param {string} [params.negative_prompt]       - Negative prompt
   * @param {number} [params.steps=20]              - Denoising step count
   * @param {number} [params.width=512]             - Output width (multiple of 8)
   * @param {number} [params.height=512]            - Output height (multiple of 8)
   * @param {number} [params.guidance=3.5]          - Distilled guidance (FLUX.2)
   * @param {number} [params.cfg_scale=7.0]         - CFG scale (SD1/SD2)
   * @param {string} [params.sampling_method]       - Sampler name
   * @param {string} [params.scheduler]             - Scheduler name
   * @param {number} [params.seed=-1]               - RNG seed; -1 = random
   * @param {number} [params.batch_count=1]         - Images per call
   * @param {boolean} [params.vae_tiling=false]     - Enable VAE tiling (for large images)
   * @param {string}  [params.cache_preset]         - Cache preset: slow/medium/fast/ultra
   * @param {Uint8Array} [params.init_image]        - Source image bytes for img2img (PNG/JPEG).
   *                                                   FLUX2: in-context conditioning (ref_images).
   *                                                   Others: SDEdit (init_image + strength).
   * @returns {Promise<QvacResponse>}
   */
  async run (params) {
    return this._run(() => this._runInternal(params))
  }

  async _runInternal (params) {
    // Validate inputs first so callers get precise errors before any
    // readiness/busy checks.
    if (params.init_image != null && !(params.init_image instanceof Uint8Array)) {
      throw new Error(
        'init_image must be a Uint8Array (e.g. fs.readFileSync("image.png")). ' +
        'Got: ' + typeof params.init_image
      )
    }

    // FLUX models require an explicit prediction type for img2img.
    // The C++ addon auto-detects the model family at load time, but
    // SdModel::process() only enters the FLUX ref_images path when
    // config_.prediction is FLUX_FLOW_PRED or FLUX2_FLOW_PRED. Without
    // an explicit value the addon silently falls back to SDEdit.
    if (params.init_image && this._files.llm) {
      const pred = this._config?.prediction
      if (pred !== 'flux2_flow' && pred !== 'flux_flow') {
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

    const mode = params.init_image ? 'img2img' : 'txt2img'
    this.logger.info('Starting generation with mode:', mode)

    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const response = this._job.start()

    let accepted
    try {
      accepted = await this.addon.runJob({ ...params, mode })
    } catch (error) {
      this._job.fail(error)
      throw error
    }

    if (!accepted) {
      this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE))
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this._hasActiveResponse = true
    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch((err) => {
      this.logger?.warn?.('Generation response rejected:', err?.message || err)
    })
    response.await = () => finalized

    this.logger.info('Generation job started successfully')
    return response
  }

  /**
   * Cancel the current generation job.
   */
  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  /**
   * Unload the model and release all resources.
   */
  async unload () {
    return this._run(async () => {
      await this.cancel()
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this._hasActiveResponse = false
      if (this.addon) {
        await this.addon.unload()
        // Null the addon reference so post-unload `cancel()` / `run()` calls hit the
        // `if (!this.addon)` guard instead of dereferencing a disposed native handle.
        this.addon = null
      }
      this._releaseNativeLogger()
      this.state.configLoaded = false
    })
  }

  getState () { return this.state }
}

module.exports = ImgStableDiffusion
