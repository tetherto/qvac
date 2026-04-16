'use strict'

const path = require('bare-path')

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const { SdInterface } = require('./addon')

const LOG_METHODS = ['error', 'warn', 'info', 'debug']

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * Text-to-image and image-to-image generation using stable-diffusion.cpp.
 * Supports SD1.x, SD2.x, SDXL, SD3, and FLUX.2 [klein].
 */
class ImgStableDiffusion extends BaseInference {
  /**
   * @param {object} args
   * @param {object} [args.logger] - Structured logger
   * @param {object} [args.opts] - Optional inference options
   * @param {string} [args.diskPath='.'] - Local directory containing model weight files
   * @param {string} args.modelName - Model file name (e.g. 'flux-2-klein-4b-Q8_0.gguf')
   * @param {string} [args.clipLModel] - Optional CLIP-L text encoder file name (SD3)
   * @param {string} [args.clipGModel] - Optional CLIP-G text encoder file name (SDXL / SD3)
   * @param {string} [args.t5XxlModel] - Optional T5-XXL text encoder file name (SD3)
   * @param {string} [args.llmModel] - Optional LLM text encoder file name (FLUX.2 klein → Qwen3 4B)
   * @param {string} [args.vaeModel] - Optional VAE file name
   * @param {object} config - SD context configuration (threads, device, type, etc.)
   */
  constructor (
    {
      opts = {},
      logger = null,
      diskPath = '.',
      modelName,
      clipLModel,
      clipGModel,
      t5XxlModel,
      llmModel,
      vaeModel
    },
    config
  ) {
    super({ logger, opts })
    this._config = config
    this._diskPath = diskPath
    this._modelName = modelName
    this._clipLModel = clipLModel || null
    this._clipGModel = clipGModel || null
    this._t5XxlModel = t5XxlModel || null
    this._llmModel = llmModel || null
    this._vaeModel = vaeModel || null
    this._hasActiveResponse = false
  }

  async _load () {
    this.logger.info('Starting stable-diffusion model load')

    try {
      // Route the primary model file to the correct stable-diffusion.cpp param:
      //
      //   model_path           — all-in-one checkpoints that embed their own text
      //                          encoders and version metadata (SD1.x, SD2.x, SDXL,
      //                          SD3 all-in-one GGUF).
      //
      //   diffusion_model_path — standalone diffusion-only weights that have no
      //                          embedded SD metadata and require separate encoders:
      //                            FLUX.2 [klein] → llmModel (Qwen3)
      //                            SD3 pure GGUF  → t5XxlModel (T5-XXL) + clipLModel + clipGModel
      //
      // Heuristic: if any separate encoder is provided (LLM for FLUX.2, T5-XXL
      // for SD3 split) the caller is using a pure diffusion GGUF that must be
      // loaded via diffusion_model_path.
      const isSplitLayout = !!this._llmModel || !!this._t5XxlModel
      const resolve = (name) => name ? (path.isAbsolute(name) ? name : path.join(this._diskPath, name)) : ''
      const configurationParams = {
        path: isSplitLayout ? '' : resolve(this._modelName),
        diffusionModelPath: isSplitLayout ? resolve(this._modelName) : '',
        clipLPath: resolve(this._clipLModel),
        clipGPath: resolve(this._clipGModel),
        t5XxlPath: resolve(this._t5XxlModel),
        llmPath: resolve(this._llmModel),
        vaePath: resolve(this._vaeModel),
        config: this._config
      }

      this.logger.info('Creating stable-diffusion addon with configuration:', configurationParams)
      this.addon = this._createAddon(configurationParams)

      this.logger.info('Activating stable-diffusion addon')
      await this.addon.activate()

      this.logger.info('Stable-diffusion model load completed successfully')
    } catch (error) {
      this.logger.error('Error during stable-diffusion model load:', error)
      throw error
    }
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
    if (event.includes('Error')) {
      return this._outputCallback(addon, 'Error', 'OnlyOneJob', data, error)
    }

    if (data instanceof Uint8Array || typeof data === 'string') {
      return this._outputCallback(addon, 'Output', 'OnlyOneJob', data, error)
    }

    // RuntimeStats is the only plain-object payload the C++ addon emits.
    // Matching structurally avoids coupling to specific stats key names.
    if (typeof data === 'object' && data !== null) {
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', data, null)
    }

    return this._outputCallback(addon, event, 'OnlyOneJob', data, error)
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
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      const currentJobResponse = this._jobToResponse.get('OnlyOneJob')
      if (currentJobResponse) {
        currentJobResponse.failed(new Error('Model was unloaded'))
        this._deleteJobMapping('OnlyOneJob')
      }
      this._hasActiveResponse = false
      if (this.addon) {
        await super.unload()
      }
      this._releaseNativeLogger()
    })
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
  async _runInternal (params) {
    // Validate init_image is Uint8Array if provided
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
    if (params.init_image && this._llmModel) {
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

    const mode = params.init_image ? 'img2img' : 'txt2img'
    this.logger.info('Starting generation with mode:', mode)

    return await this._withExclusiveRun(async () => {
      if (this._hasActiveResponse) {
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }

      const response = this._createResponse('OnlyOneJob')

      let accepted
      try {
        accepted = await this.addon.runJob({ ...params, mode })
      } catch (error) {
        this._deleteJobMapping('OnlyOneJob')
        response.failed(error)
        throw error
      }

      if (!accepted) {
        this._deleteJobMapping('OnlyOneJob')
        const msg = RUN_BUSY_ERROR_MESSAGE
        response.failed(new Error(msg))
        throw new Error(msg)
      }

      this._hasActiveResponse = true
      const finalized = response.await().finally(() => { this._hasActiveResponse = false })
      finalized.catch(() => {})
      response.await = () => finalized

      this.logger.info('Generation job started successfully')

      return response
    })
  }
}

module.exports = ImgStableDiffusion
