'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { LlamaInterface } = require('./addon')

const noop = () => { }

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

function normalizeRunOptions (runOptions) {
  if (runOptions === undefined) {
    return { prefill: false, generationParams: undefined }
  }

  if (!runOptions || typeof runOptions !== 'object' || Array.isArray(runOptions)) {
    throw new TypeError('Run options must be an object when provided')
  }

  if (runOptions.prefill !== undefined &&
      typeof runOptions.prefill !== 'boolean') {
    throw new TypeError('prefill must be a boolean when provided')
  }

  if (runOptions.generationParams !== undefined &&
      (typeof runOptions.generationParams !== 'object' || runOptions.generationParams === null || Array.isArray(runOptions.generationParams))) {
    throw new TypeError('generationParams must be a plain object when provided')
  }

  return {
    prefill: runOptions.prefill === true,
    generationParams: runOptions.generationParams
  }
}

const VALIDATION_TYPES = ['none', 'split', 'dataset']
const DEFAULT_VALIDATION_FRACTION = 0.05

function normalizeFinetuneParams (opts) {
  const validation = opts.validation
  if (Object.prototype.hasOwnProperty.call(opts, 'evalDatasetPath')) {
    throw new Error(
      "Top-level evalDatasetPath is no longer supported. Use validation.path with validation.type set to 'dataset'."
    )
  }
  if (validation == null || typeof validation !== 'object' || !('type' in validation)) {
    throw new Error(
      'Finetuning options must include validation: { type: \'none\' | \'split\' | \'dataset\'[, fraction?: number][, path?: string] }. ' +
      'Example: validation: { type: \'split\', fraction: 0.05 }, validation: { type: \'dataset\', path: \'./eval.jsonl\' }, or validation: { type: \'none\' }.'
    )
  }
  const out = { ...opts }
  const type = validation.type
  if (!VALIDATION_TYPES.includes(type)) {
    throw new Error(
      `validation.type must be one of ${VALIDATION_TYPES.join(', ')}; got: ${type}`
    )
  }
  if (type === 'none') {
    out.validationSplit = 0
    out.useEvalDatasetForValidation = false
    delete out.evalDatasetPath
  } else if (type === 'split') {
    const fraction = validation.fraction ?? DEFAULT_VALIDATION_FRACTION
    out.validationSplit = Math.max(0, Math.min(1, Number(fraction)))
    out.useEvalDatasetForValidation = false
    delete out.evalDatasetPath
  } else {
    const evalPath = validation.path
    if (!evalPath || typeof evalPath !== 'string' || evalPath.trim() === '') {
      throw new Error(
        "validation.type is 'dataset' but no path is provided. Set validation.path to the eval dataset file path (e.g. validation: { type: 'dataset', path: './eval.jsonl' })."
      )
    }
    if (evalPath === opts.trainDatasetDir) {
      throw new Error(
        "validation.type is 'dataset' but validation.path is the same as trainDatasetDir. Provide a separate eval dataset path."
      )
    }
    out.evalDatasetPath = evalPath
    out.validationSplit = 0
    out.useEvalDatasetForValidation = true
  }
  delete out.validation
  return out
}

/**
 * GGML client implementation for Llama LLM model
 */
class LlmLlamacpp extends BaseInference {
  /**
   * Creates an instance of LlmLlamacpp.
   * @constructor
   * @param {Object} args - Setup parameters including loader, logger, disk path, and model name
   * @param {Loader} args.loader - External loader instance
   * @param {Logger} [args.logger] - Optional structured logger
   * @param {Object} [args.opts] - Optional inference options
   * @param {string} args.diskPath - Disk directory where model files are stored
   * @param {string} args.modelName - Name of the model directory or file. The usage of a sharded
   * filename (e.g. "llama-00001-of-00004.gguf") will trigger asynchronous loading of the weights for
   * all remaining files.
   * @param {string} args.projectionModel - Name of the projection model directory or file
   * @param {Object} config - Model-specific configuration settings
   */
  constructor (
    { opts = {}, loader, logger = null, diskPath = '.', modelName, projectionModel },
    config
  ) {
    super({ logger, opts })
    this._config = config
    this._diskPath = diskPath
    this._modelName = modelName
    this._projectionModel = projectionModel
    this._shards = WeightsProvider.expandGGUFIntoShards(this._modelName)
    this.weightsProvider = new WeightsProvider(loader, this.logger)
    this._checkpointSaveDir = null
    this._hasActiveResponse = false
    this._skipNextRuntimeStats = false
    this._originalLogger = this.logger
    this._baseOutputCallback = this._outputCallback.bind(this)
  }

  /**
   * Load model weights, initialize the native addon, and activate the model.
   * @param {boolean} [closeLoader=true] - Whether to close the loader when complete
   * @param {ProgressReportCallback} [onDownloadProgress] - Optional byte-level progress callback
   * @returns {Promise<void>}
   */
  async _load (closeLoader = true, onDownloadProgress = noop) {
    this.logger.info('Starting model load')

    try {
      const configForLoad = { ...this._config }

      const configurationParams = {
        path: path.join(this._diskPath, this._modelName),
        projectionPath: this._projectionModel ? path.join(this._diskPath, this._projectionModel) : '',
        config: configForLoad
      }

      this.logger.info('Creating addon with configuration:', configurationParams)
      this.addon = this._createAddon(configurationParams)

      if (this._shards !== null) {
        await this._loadWeights(onDownloadProgress)
      } else {
        await this.downloadWeights(onDownloadProgress, { closeLoader })
      }

      this.logger.info('Activating addon')
      await this.addon.activate()

      this.logger.info('Model load completed successfully')
    } catch (error) {
      this.logger.error('Error during model load:', error)
      throw error
    }
  }

  /**
   * Download the model weight files and return the local path to the primary file.
   * @param {ProgressReportCallback} [onDownloadProgress] - Callback invoked with bytes downloaded
   * @returns {Promise<{filePath: string, completed: boolean, error: boolean}[]>} Local file path for the model weights
   */
  async _downloadWeights (onDownloadProgress, opts) {
    return await this.weightsProvider.downloadFiles(
      this._projectionModel ? [this._modelName, this._projectionModel] : [this._modelName],
      this._diskPath,
      {
        closeLoader: opts.closeLoader,
        onDownloadProgress
      }
    )
  }

  async _loadWeights (reportProgressCallback) {
    const onChunk = async (chunkedWeightsData) => {
      this.addon.loadWeights(chunkedWeightsData, this.logger)
    }
    await this.weightsProvider.streamFiles(this._shards, onChunk, reportProgressCallback)
  }

  _isSuppressedNoResponseLog (args) {
    const message = args.map(arg => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') {
        if (arg.message && typeof arg.message === 'string') return arg.message
        return JSON.stringify(arg)
      }
      return String(arg)
    }).join(' ')
    return message && message.includes('No response found for job')
  }

  _createFilteredLogger (sourceLogger) {
    const filteredLogger = sourceLogger ? Object.create(Object.getPrototypeOf(sourceLogger)) : {}
    Object.assign(filteredLogger, sourceLogger)

    const originalInfo = sourceLogger && typeof sourceLogger.info === 'function'
      ? sourceLogger.info.bind(sourceLogger)
      : null
    const originalWarn = sourceLogger && typeof sourceLogger.warn === 'function'
      ? sourceLogger.warn.bind(sourceLogger)
      : null

    filteredLogger.info = (...args) => {
      if (this._isSuppressedNoResponseLog(args)) return
      if (originalInfo) return originalInfo.apply(sourceLogger, args)
    }

    filteredLogger.warn = (...args) => {
      if (this._isSuppressedNoResponseLog(args)) return
      if (originalWarn) return originalWarn.apply(sourceLogger, args)
    }

    return filteredLogger
  }

  _handleAddonOutputEvent (originalOutputCb, originalLoggerRef, instance, eventType, jobId, data, extra) {
    if (eventType === 'JobEnded' || eventType === 'Error') {
      this._hasActiveResponse = false
    }

    if (eventType === 'LogMsg') {
      const logMsg = typeof data === 'string' ? data : (data?.message || JSON.stringify(data))
      originalLoggerRef?.info?.(logMsg)
      return
    }

    if (originalOutputCb) {
      return originalOutputCb(instance, eventType, jobId, data, extra)
    }
  }

  /**
   * Public API entrypoint for inference.
   * @param {Message[]} prompt - Input prompt array of messages
   * @param {{prefill?: boolean}} [runOptions] - Optional run settings
   * @returns {Promise<QvacResponse>}
   */
  async run (prompt, runOptions = {}) {
    return await this._runInternal(prompt, runOptions)
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Local file or directory path
   * @param {Object} configurationParams.settings - LLM-specific settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon (configurationParams) {
    const binding = require('./binding')

    this.logger = this._createFilteredLogger(this._originalLogger)

    this._outputCallback = (instance, eventType, jobId, data, extra) => {
      return this._handleAddonOutputEvent(
        this._baseOutputCallback,
        this._originalLogger,
        instance,
        eventType,
        jobId,
        data,
        extra
      )
    }

    return new LlamaInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    if (typeof data === 'object' && data !== null && 'TPS' in data) {
      if (this._skipNextRuntimeStats) {
        this._skipNextRuntimeStats = false
        return
      }
      const runtimeStats = { ...data }
      if (runtimeStats.backendDevice === 0) {
        runtimeStats.backendDevice = 'cpu'
      } else if (runtimeStats.backendDevice === 1) {
        runtimeStats.backendDevice = 'gpu'
      }
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', runtimeStats, null)
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      data.op === 'finetune' &&
      typeof data.status === 'string'
    ) {
      this._skipNextRuntimeStats = true
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', data, null)
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      data.type === 'finetune_progress'
    ) {
      return this._outputCallback(addon, 'FinetuneProgress', 'OnlyOneJob', data, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (typeof data === 'string') {
      mappedEvent = 'Output'
    }

    return this._outputCallback(addon, mappedEvent, 'OnlyOneJob', data, error)
  }

  /**
   * Pause finetuning, saving a checkpoint so training can resume later.
   * cancel inference job if it is running
   */
  async pause () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  /**
   * Cancel finetuning and remove the pause checkpoint so the next
   * finetune() call starts fresh instead of resuming.
   * cancel inference job if it is running
   */
  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
    this._clearPauseCheckpoints()
  }

  _clearPauseCheckpoints () {
    const checkpointDir = this._checkpointSaveDir
    if (!checkpointDir) return
    try {
      const entries = fs.readdirSync(checkpointDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('pause_checkpoint_step_')) {
          fs.rmSync(path.join(checkpointDir, entry.name), { recursive: true, force: true })
        }
      }
    } catch (err) {
      this.logger.error('Failed to clear pause checkpoints:', err)
    }
  }

  /**
   * Unload model safely by cancelling and clearing pending jobs.
   * @returns {Promise<void>}
   */
  async unload () {
    return await this._withExclusiveRun(async () => {
      try {
        await this.pause()
      } catch (_) {}
      const currentJobResponse = this._jobToResponse.get('OnlyOneJob')
      if (currentJobResponse) {
        currentJobResponse.failed(new Error('Model was unloaded'))
        this._deleteJobMapping('OnlyOneJob')
      }
      this._hasActiveResponse = false
      await super.unload()
    })
  }

  /**
   * Internal method to start inference with a text prompt.
   * @param {Message[]} prompt - Input prompt array of messages
   * @param {{prefill?: boolean}} [runOptions] - Optional run settings
   * @returns {Promise<QvacResponse>} A QvacResponse representing the inference job
   */
  async _runInternal (prompt, runOptions = {}) {
    return this._withExclusiveRun(async () => {
      if (this._hasActiveResponse) {
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }

      if (!Array.isArray(prompt)) {
        throw new TypeError('Prompt input must be Message[]')
      }
      const { prefill, generationParams } = normalizeRunOptions(runOptions)

      this.logger.info('Starting inference with prompt:', prompt)

      // Separate media messages from text messages
      const textMessages = []
      const mediaItems = []

      for (const message of prompt) {
        if (message.role === 'user' &&
            message.type === 'media' &&
            message.content instanceof Uint8Array) {
          mediaItems.push(message.content)
          // Keep the message as a placeholder marker (with empty content) for tokenization
          textMessages.push({ ...message, content: '' })
        } else {
          textMessages.push(message)
        }
      }

      const promptMessages = []

      // Send media first (in order) if present
      for (const mediaData of mediaItems) {
        promptMessages.push({ type: 'media', content: mediaData })
      }

      // Send text messages
      promptMessages.push({
        type: 'text',
        input: JSON.stringify(textMessages),
        prefill,
        generationParams
      })

      const response = this._createResponse('OnlyOneJob')

      // addon-cpp C++ guarantees no events will be generated
      // until job is fully accepted. This means even if trying
      // to queue a job fails right now as not accepted,
      // it will not generate events.
      //
      // If any unexpected exception is thrown (e.g. in the C++ code)
      // it will unwind here and the job will not be accepted.
      let accepted
      try {
        accepted = await this.addon.runJob(promptMessages)
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

      this.logger.info('Inference job started successfully')

      return response
    })
  }

  async finetune (finetuningOptions = undefined) {
    if (!this.addon) {
      throw new Error(
        'Addon not initialized. Call load() first.'
      )
    }

    if (!finetuningOptions) {
      throw new Error(
        'Finetuning parameters are required.'
      )
    }
    if (finetuningOptions.checkpointSaveDir) {
      this._checkpointSaveDir = finetuningOptions.checkpointSaveDir
    }
    const paramsToSend = normalizeFinetuneParams(finetuningOptions)
    this.logger?.info?.('finetune() called')
    this.logger?.info?.('Finetuning parameters:', finetuningOptions)

    return this._withExclusiveRun(async () => {
      if (this._hasActiveResponse) {
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }

      const response = this._createResponse('OnlyOneJob')
      let accepted
      try {
        accepted = await this.addon.finetune(paramsToSend)
      } catch (err) {
        this._deleteJobMapping('OnlyOneJob')
        response.failed(err)
        throw err
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

      return response
    })
  }
}

module.exports = LlmLlamacpp
