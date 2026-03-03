'use strict'

const path = require('bare-path')

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { SdInterface } = require('./addon')

const noop = () => {}

/** Max ms to wait for the previous job to finish before throwing. */
const PREVIOUS_JOB_WAIT_MS = 30
const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * Image and video generation using stable-diffusion.cpp.
 * Supports SD1.x, SD2.x, SDXL, SD3, FLUX, Wan2.x video models.
 */
class ImgStableDiffusion extends BaseInference {
  /**
   * @param {object} args
   * @param {object} args.loader - Data loader (Hyperdrive, filesystem, etc.)
   * @param {object} [args.logger] - Structured logger
   * @param {object} [args.opts] - Optional inference options
   * @param {string} [args.diskPath='.'] - Local directory for downloaded weights
   * @param {string} args.modelName - Model file name (e.g. 'flux1-dev-q4_0.gguf')
   * @param {string} [args.clipLModel] - Optional CLIP-L model file name (FLUX.1 / SD3)
   * @param {string} [args.clipGModel] - Optional CLIP-G model file name (SDXL / SD3)
   * @param {string} [args.t5XxlModel] - Optional T5-XXL text encoder file name (FLUX.1 / SD3)
   * @param {string} [args.llmModel] - Optional LLM text encoder file name (FLUX.2 klein → Qwen3 8B)
   * @param {string} [args.vaeModel] - Optional VAE file name
   * @param {object} config - SD context configuration (threads, device, wtype, etc.)
   */
  constructor (
    {
      opts = {},
      loader,
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
    this.weightsProvider = new WeightsProvider(loader, this.logger)
    this._lastJobResult = Promise.resolve()
  }

  /**
   * Load model weights, initialize the native addon, and activate.
   * @param {boolean} [closeLoader=true]
   * @param {Function} [onDownloadProgress]
   */
  async _load (closeLoader = true, onDownloadProgress = noop) {
    this.logger.info('Starting stable-diffusion model load')

    try {
      const filesToDownload = [this._modelName]
      if (this._clipLModel) filesToDownload.push(this._clipLModel)
      if (this._clipGModel) filesToDownload.push(this._clipGModel)
      if (this._t5XxlModel) filesToDownload.push(this._t5XxlModel)
      if (this._llmModel) filesToDownload.push(this._llmModel)
      if (this._vaeModel) filesToDownload.push(this._vaeModel)

      await this.weightsProvider.downloadFiles(filesToDownload, this._diskPath, {
        closeLoader,
        onDownloadProgress
      })

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
      const configurationParams = {
        path: isSplitLayout ? '' : path.join(this._diskPath, this._modelName),
        diffusionModelPath: isSplitLayout ? path.join(this._diskPath, this._modelName) : '',
        clipLPath: this._clipLModel ? path.join(this._diskPath, this._clipLModel) : '',
        clipGPath: this._clipGModel ? path.join(this._diskPath, this._clipGModel) : '',
        t5XxlPath: this._t5XxlModel ? path.join(this._diskPath, this._t5XxlModel) : '',
        llmPath: this._llmModel ? path.join(this._diskPath, this._llmModel) : '',
        vaePath: this._vaeModel ? path.join(this._diskPath, this._vaeModel) : '',
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
   * @param {Function} [onDownloadProgress]
   * @param {object} [opts]
   */
  async _downloadWeights (onDownloadProgress, opts) {
    const filesToDownload = [this._modelName]
    if (this._clipLModel) filesToDownload.push(this._clipLModel)
    if (this._clipGModel) filesToDownload.push(this._clipGModel)
    if (this._t5XxlModel) filesToDownload.push(this._t5XxlModel)
    if (this._llmModel) filesToDownload.push(this._llmModel)
    if (this._vaeModel) filesToDownload.push(this._vaeModel)

    return this.weightsProvider.downloadFiles(filesToDownload, this._diskPath, {
      closeLoader: opts.closeLoader,
      onDownloadProgress
    })
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
    if (typeof data === 'object' && data !== null && 'generation_time' in data) {
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', data, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (data instanceof Uint8Array) {
      mappedEvent = 'Output'
    } else if (typeof data === 'string') {
      try {
        JSON.parse(data)
      } catch (_) {}
      mappedEvent = 'Output'
    }

    return this._outputCallback(addon, mappedEvent, 'OnlyOneJob', data, error)
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
    return this._withExclusiveRun(async () => {
      await this.cancel()
      const currentJobResponse = this._jobToResponse.get('OnlyOneJob')
      if (currentJobResponse) {
        currentJobResponse.failed(new Error('Model was unloaded'))
        this._deleteJobMapping('OnlyOneJob')
      }
      // Guard: addon may never have been created if _load() threw before assignment.
      if (this.addon) {
        await super.unload()
      }
    })
  }

  /**
   * Generate an image from a text prompt (primary API).
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
   * @returns {Promise<QvacResponse>}
   */
  async run (params) {
    return this._runGeneration({ ...params, mode: 'txt2img' })
  }

  /**
   * Generate an image from an input image and text prompt.
   *
   * @param {object} params
   * @param {Uint8Array} params.init_image   - Source image bytes (PNG/JPEG)
   * @param {string}     params.prompt
   * @param {number}    [params.strength=0.75] - 0 = keep source, 1 = ignore source
   * @returns {Promise<QvacResponse>}
   */
  async img2img (params) {
    if (!params.init_image) throw new Error('img2img requires init_image')
    return this._runGeneration({ ...params, mode: 'img2img' })
  }

  async _runGeneration (params) {
    this.logger.info('Starting generation with mode:', params.mode)

    return this._withExclusiveRun(async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(RUN_BUSY_ERROR_MESSAGE))
        }, PREVIOUS_JOB_WAIT_MS)
        this._lastJobResult
          .then(() => { clearTimeout(timer); resolve() })
          .catch(() => { clearTimeout(timer); resolve() })
      })

      const response = this._createResponse('OnlyOneJob')

      let accepted
      try {
        accepted = await this.addon.runJob(params)
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

      this._lastJobResult = response.await()

      this.logger.info('Generation job started successfully')

      return response
    })
  }
}

module.exports = ImgStableDiffusion
