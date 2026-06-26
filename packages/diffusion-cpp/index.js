'use strict'

const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { SdInterface, EsrganUpscalerInterface, mapAddonEvent } = require('./addon')

const COMPANION_FILE_KEYS = [
  'clipL',
  'clipG',
  't5Xxl',
  'llm',
  'vae',
  'esrgan',
  'highNoiseDiffusionModel'
]

function assertAbsolute (key, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`files.${key} must be an absolute path string`)
  }
  if (!path.isAbsolute(value)) {
    throw new TypeError(`files.${key} must be an absolute path (got: ${value})`)
  }
}

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

// Normalize image-bytes input from a variety of shapes that JS callers may
// hand us:
//   - Uint8Array  -> returned as-is
//   - Buffer (Node) / Uint8ClampedArray / any ArrayBuffer.isView with 1-byte
//     elements -> wrapped in a Uint8Array sharing the same memory
//   - ArrayBuffer / SharedArrayBuffer -> wrapped in a Uint8Array view
//
// Throws TypeError on anything else so callers get a precise diagnostic
// before the value reaches the native binding (which only accepts
// Uint8Array).
function _coerceToUint8 (name, value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value) && value.BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
    return new Uint8Array(value)
  }
  throw new TypeError(
    `${name} must be a Uint8Array / Buffer / ArrayBuffer of PNG/JPEG bytes. ` +
    `Got: ${value === null ? 'null' : typeof value}`
  )
}
// Matches C++ int max: repeats are stored as int and used in native loop counters.
const NATIVE_UPSCALE_REPEATS_MAX = 2147483647

function normalizeUpscaleRepeats (options) {
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
   * @param {string} [args.files.esrgan] - ESRGAN upscaler model (absolute path)
   * @param {string} [args.files.highNoiseDiffusionModel] - Wan 2.2 high-noise expert (absolute path); omit for all other models
   * @param {object} [args.config] - SD context configuration (threads, device, type, etc.).
   *   Optional — when omitted, the addon forwards an empty config and the C++ layer falls
   *   back to stable-diffusion.cpp defaults for every parameter.
   * @param {object} [args.logger] - Structured logger for JS wrapper logs.
   *   Native C++ logs are process-global; configure them once with
   *   `require('@qvac/diffusion-cpp/addonLogging').setLogger(...)`.
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
      highNoiseDiffusionModelPath: this._files.highNoiseDiffusionModel || '',
      clipLPath: this._files.clipL || '',
      clipGPath: this._files.clipG || '',
      t5XxlPath: this._files.t5Xxl || '',
      llmPath: this._files.llm || '',
      vaePath: this._files.vae || '',
      clipVisionPath: this._files.clipVision || '',
      esrganPath: this._files.esrgan || '',
      // LTX-2 (LTXAV) extras: never set for image models, but the native
      // createInstance reads both keys unconditionally, so pass empty strings.
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
      // Best-effort cleanup of the partially-initialized addon so a subsequent
      // load() does not leak a zombie native instance.
      try { await this.addon?.unload?.() } catch (_) {}
      this.addon = null
      throw loadError
    }

    this.logger.info('Stable-diffusion model load completed successfully')
  }

  /**
   * @param {object} configurationParams
   * @returns {SdInterface}
   */
  _createAddon (configurationParams) {
    const binding = require('./binding')
    return new SdInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
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
   * @param {string}  [params.lora]                 - Non-empty absolute path to a LoRA adapter (.safetensors, etc.)
   * @param {boolean|object} [params.upscale]        - Post-generation ESRGAN upscale (requires files.esrgan)
   * @param {number} [params.upscale.repeats=1]      - Number of ESRGAN passes
   * @param {Uint8Array} [params.init_image]        - Source image bytes for img2img (PNG/JPEG).
   *                                                   FLUX2: in-context conditioning (ref_images).
   *                                                   Others: SDEdit (init_image + strength).
   * @param {Uint8Array[]} [params.init_images]     - **FLUX2-only**. Array of reference images
   *                                                   (PNG/JPEG) for multi-reference "fusion"
   *                                                   conditioning. Addressed in the prompt as
   *                                                   `@image1 … @imageN`. Mutually exclusive
   *                                                   with `init_image`.
   * @returns {Promise<QvacResponse>}
   */
  async run (params) {
    return this._run(() => this._runInternal(params))
  }

  async _runInternal (params) {
    // Validate inputs first so callers get precise errors before any
    // readiness/busy checks.

    // ── FLUX img2img dimension defaults ────────────────────────────────────────
    // For FLUX in img2img/fusion mode, inject 1024 for omitted width/height axes.
    // This must happen before dimension validation so FLUX defaults are checked
    // against the multiple-of-8 constraint.
    const isSingleImage = params.init_image != null
    const maybeInitImages = Array.isArray(params.init_images) && params.init_images.length > 0
    const predictionForDefaults = params.prediction || (this._config && this._config.prediction)
    if ((isSingleImage || maybeInitImages) && predictionForDefaults) {
      params = applyFluxImg2ImgDimDefaults(params, predictionForDefaults, maybeInitImages)
    }

    // ── Dimension validation ────────────────────────────────────────────────
    // Only validate dimensions the caller actually provided. When width/height
    // are omitted the addon falls back to its defaults (512x512), and using
    // `undefined % 8` here would yield NaN which spuriously trips the guard
    // for every txt2img / img2img call that omits explicit dimensions.
    // Note: in JS, `0 % 8 === 0` and `-8 % 8 === 0`, so `% alignTo !== 0`
    // alone happily lets through zero / negative dimensions. We require
    // positivity explicitly here to match the C++ handler invariant
    // (`requirePositiveInt` in SdGenHandlers).
    const alignTo = 8
    const w = params.width
    const h = params.height
    const wProvided = w != null
    const hProvided = h != null
    const wBad = wProvided && (!Number.isFinite(w) || w <= 0 || w % alignTo !== 0)
    const hBad = hProvided && (!Number.isFinite(h) || h <= 0 || h % alignTo !== 0)
    if (wBad || hBad) {
      const suggestW = Number.isFinite(w) && w > 0 ? Math.round(w / alignTo) * alignTo : 512
      const suggestH = Number.isFinite(h) && h > 0 ? Math.round(h / alignTo) * alignTo : 512
      throw new Error(
        `width and height must be positive multiples of ${alignTo}. ` +
        `Got: ${w}x${h}. ` +
        `Use ${suggestW}x${suggestH} instead.`
      )
    }

    // ── Prompt validation ──────────────────────────────────────────────────
    // The JSDoc + .d.ts both mark `prompt` as required; enforce that at
    // runtime so callers get a precise JS-side error rather than the native
    // layer either silently producing garbage or surfacing a generic
    // "prompt must be a string" from the JSON handler chain.
    if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
      throw new TypeError(
        `params.prompt is required and must be a non-empty string. Got: ${typeof params.prompt}`
      )
    }

    // ── init_image / init_images validation ────────────────────────────────
    // Type-check: reject non-array init_images to prevent silent fallback to txt2img
    if (params.init_images != null && !Array.isArray(params.init_images)) {
      throw new TypeError(
        'init_images must be an Array of Uint8Array; got ' + typeof params.init_images
      )
    }

    const hasInitImages =
      Array.isArray(params.init_images) && params.init_images.length > 0

    // Mutual exclusion — pick one, not both.
    if (params.init_image != null && hasInitImages) {
      throw new Error(
        'init_image and init_images are mutually exclusive — pick one. ' +
        'Use init_images (with FLUX.2) for multi-reference "fusion" mode, ' +
        'or init_image for single-image conditioning (SDEdit / FLUX.2 single-ref).'
      )
    }

    // Single-image type check.
    //
    // Accept any byte-shaped TypedArray (Uint8Array, Buffer, Uint8ClampedArray)
    // **and** raw ArrayBuffer / SharedArrayBuffer, then normalize to a
    // Uint8Array view that the native binding can accept. Bare/Node both
    // hand back Buffer from fs.readFileSync, and Buffer is a Uint8Array
    // subclass on Node but not always on Bare-managed runtimes; the
    // explicit check via `ArrayBuffer.isView` keeps both paths working.
    if (params.init_image != null) {
      params.init_image = _coerceToUint8('init_image', params.init_image)
    }

    // Multi-image: check array is not empty.
    if (params.init_images != null && Array.isArray(params.init_images) && params.init_images.length === 0) {
      throw new Error(
        'init_images must not be an empty array. ' +
        'Pass at least one reference image or use init_image for single-image mode.'
      )
    }

    // Multi-image: every entry must be a non-empty bytes-like view.
    // Same coercion as init_image: accept Buffer / Uint8ClampedArray /
    // ArrayBuffer in addition to plain Uint8Array.
    if (hasInitImages) {
      for (let i = 0; i < params.init_images.length; i++) {
        const img = params.init_images[i]
        let coerced
        try {
          coerced = _coerceToUint8(`init_images[${i}]`, img)
        } catch {
          throw new TypeError(`init_images[${i}] must be a non-empty Uint8Array`)
        }
        if (coerced.length === 0) {
          throw new TypeError(`init_images[${i}] must be a non-empty Uint8Array`)
        }
        params.init_images[i] = coerced
      }
    }

    // Multi-reference fusion is a FLUX2-only feature.
    // The C++ addon re-validates this (see SdModel::process) but we fail
    // fast here with a clearer message and before any native work starts.
    const pred = this._config?.prediction
    if (hasInitImages) {
      const isFlux2 = !!this._files?.llm && pred === 'flux2_flow'
      if (!isFlux2) {
        throw new Error(
          'init_images (multi-reference fusion) requires a FLUX.2 model. ' +
          "Load a FLUX.2 [klein] checkpoint with files.llm set and pass config.prediction: 'flux2_flow'. " +
          'Other architectures (SD1.x, SD2.x, SDXL, SD3, single-image FLUX.2) do not support ' +
          '@image1/@imageN in-context references.'
        )
      }

      // Validate increase_ref_index parameter.
      if (params.increase_ref_index != null) {
        if (typeof params.increase_ref_index !== 'boolean') {
          throw new Error(
            'increase_ref_index must be a boolean. ' +
            'Got: ' + typeof params.increase_ref_index
          )
        }
      }

      // Validate auto_resize_ref_image parameter.
      if (params.auto_resize_ref_image != null) {
        if (typeof params.auto_resize_ref_image !== 'boolean') {
          throw new Error(
            'auto_resize_ref_image must be a boolean. ' +
            'Got: ' + typeof params.auto_resize_ref_image
          )
        }
      }

      // Prompt sanity-check: warn (not throw) if the prompt never mentions
      // any of the @imageN placeholders. FLUX2 will still run, but the
      // references will be ignored and the output will effectively be a
      // plain txt2img — almost never what the caller wanted.
      const prompt = typeof params.prompt === 'string' ? params.prompt : ''
      const mentioned = []
      const missing = []
      for (let i = 1; i <= params.init_images.length; i++) {
        const tag = '@image' + i
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

    // Validate increase_ref_index outside of fusion context (error if used).
    if (params.increase_ref_index != null && !hasInitImages) {
      throw new Error(
        'increase_ref_index is only valid with init_images (multi-reference fusion). ' +
        'Your params do not include init_images.'
      )
    }

    // Validate auto_resize_ref_image outside of fusion context (error if used).
    if (params.auto_resize_ref_image != null && !params.init_image && !hasInitImages) {
      throw new Error(
        'auto_resize_ref_image can only be used with init_image or init_images. ' +
        'No reference images provided.'
      )
    }

    // Validate LoRA parameter (absolute path required).
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

    // FLUX models require an explicit prediction type for img2img (single ref).
    // The C++ addon auto-detects the model family at load time, but
    // SdModel::process() only enters the FLUX ref_images path when
    // config_.prediction is FLUX_FLOW_PRED or FLUX2_FLOW_PRED. Without
    // an explicit value the addon silently falls back to SDEdit.
    if (params.init_image && this._files.llm) {
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

    const mode = (params.init_image || hasInitImages) ? 'img2img' : 'txt2img'
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
   * During ESRGAN upscale, cancellation is honored between repeat passes.
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
      this.state.configLoaded = false
    })
  }

  getState () { return this.state }
}

/**
 * Standalone ESRGAN image upscaling using stable-diffusion.cpp.
 * Accepts encoded PNG/JPEG bytes and emits PNG bytes.
 */
class EsrganUpscaler {
  /**
   * @param {object} args
   * @param {object} args.files - Absolute file paths for ESRGAN components
   * @param {string} args.files.esrgan - ESRGAN upscaler model (absolute path)
   * @param {object} [args.config] - ESRGAN context configuration (`device`:
   *   `'gpu'` by default, or `'cpu'`; `'gpu'` tries GPU then falls back to CPU).
   * @param {object} [args.logger] - Structured logger for JS wrapper logs.
   *   Native C++ logs are process-global; configure them once with
   *   `require('@qvac/diffusion-cpp/addonLogging').setLogger(...)`.
   * @param {object} [args.opts] - Optional inference options
   */
  constructor ({ files, config, logger = null, opts = {} }) {
    if (!files || typeof files !== 'object') {
      throw new TypeError('files must be an object containing { esrgan }')
    }
    assertAbsolute('esrgan', files.esrgan)

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

  async load () {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
    })
  }

  async _load () {
    this.logger.info('Starting ESRGAN upscaler load')

    const configurationParams = {
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
      try { await this.addon?.unload?.() } catch (_) {}
      this.addon = null
      throw loadError
    }

    this.logger.info('ESRGAN upscaler load completed successfully')
  }

  /**
   * @param {object} configurationParams
   * @returns {EsrganUpscalerInterface}
   */
  _createAddon (configurationParams) {
    const binding = require('./binding')
    return new EsrganUpscalerInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) {
      this.logger.debug(`Unhandled addon event: ${event} (data type: ${typeof data})`)
      return
    }

    if (mapped.type === 'Error') {
      this.logger.error('ESRGAN upscale failed with error:', mapped.error)
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
   * Upscale an existing encoded PNG/JPEG image and emit PNG bytes.
   *
   * @param {Uint8Array} imageBytes - Encoded PNG/JPEG input image bytes
   * @param {object} [options]
   * @param {number} [options.repeats=1] - Number of ESRGAN passes
   * @returns {Promise<QvacResponse>}
   */
  async upscale (imageBytes, options) {
    return this._run(() => this._upscaleInternal(imageBytes, options))
  }

  async _upscaleInternal (imageBytes, options) {
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

    let accepted
    try {
      accepted = await this.addon.runJob(imageBytes, { repeats })
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
      this.logger?.warn?.('ESRGAN upscale response rejected:', err?.message || err)
    })
    response.await = () => finalized

    this.logger.info('ESRGAN upscale job started successfully')
    return response
  }

  /**
   * Cancel the current upscale job.
   * Cancellation is honored between ESRGAN repeat passes.
   */
  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  async unload () {
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

  getState () { return this.state }
}

/**
 * Apply default dimensions for FLUX img2img when width/height are omitted.
 *
 * FLUX img2img performs best with square 1024x1024 dimensions. When width/height
 * are omitted, this helper injects 1024 for the missing axes (unless they are
 * already explicit).
 *
 * For non-FLUX predictions (e.g., "v" for SD2) or when both width and height
 * are explicit, the params are returned unchanged.
 *
 * @param {object} params - Generation parameters (prompt, init_image, width?, height?, ...)
 * @param {string} prediction - Prediction type (e.g., "flux2_flow", "v")
 * @param {boolean} hasInitImages - True if fusion mode (init_images present);
 *   false for single init_image (img2img). Only affects classification; the
 *   dimension logic is the same.
 * @returns {object} Modified params with injected width/height if applicable
 */
function applyFluxImg2ImgDimDefaults (params, prediction, hasInitImages) {
  // Only apply defaults for FLUX predictions in img2img/fusion mode.
  // Do NOT apply for other predictions (SD1.x, SD2.x, SDXL, SD3) which use
  // image-based defaults.
  const isFlux = prediction === 'flux_flow' || prediction === 'flux2_flow'
  if (!isFlux) {
    return params
  }

  // If both width and height are already provided, return as-is.
  if (params.width !== undefined && params.height !== undefined) {
    return params
  }

  // Inject 1024 for any omitted axis.
  return {
    ...params,
    width: params.width !== undefined ? params.width : 1024,
    height: params.height !== undefined ? params.height : 1024
  }
}

module.exports = ImgStableDiffusion
module.exports.ImgStableDiffusion = ImgStableDiffusion
module.exports.VideoStableDiffusion = require('./video')
module.exports.EsrganUpscaler = EsrganUpscaler
module.exports.applyFluxImg2ImgDimDefaults = applyFluxImg2ImgDimDefaults
