'use strict'

const path = require('bare-path')

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { LlamaInterface } = require('./addon')

const noop = () => { }

const PREVIOUS_JOB_WAIT_MS = 30
const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'
const RUN_QUEUE_BUSY_ERROR =
  'A finetune or run is already set or being processed. Wait for it to complete or pause before calling run() or finetune() again.'

const VALIDATION_TYPES = ['none', 'split', 'dataset']
const DEFAULT_VALIDATION_FRACTION = 0.05

function normalizeFinetuneParams (opts) {
  const validation = opts.validation
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
  } else if (type === 'split') {
    const fraction = validation.fraction ?? DEFAULT_VALIDATION_FRACTION
    out.validationSplit = Math.max(0, Math.min(1, Number(fraction)))
    out.useEvalDatasetForValidation = false
  } else {
    const evalPath = validation.path ?? opts.evalDatasetDir
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

const VALIDATION_TYPES = ['none', 'split', 'dataset']
const DEFAULT_VALIDATION_FRACTION = 0.05

function normalizeFinetuneParams (opts) {
  const validation = opts.validation
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
  } else if (type === 'split') {
    const fraction = validation.fraction ?? DEFAULT_VALIDATION_FRACTION
    out.validationSplit = Math.max(0, Math.min(1, Number(fraction)))
    out.useEvalDatasetForValidation = false
  } else {
    const evalPath = validation.path ?? opts.evalDatasetDir
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
    config,
    finetuningParams = null
  ) {
    super({ logger, opts })
    this._config = config
    this._diskPath = diskPath
    this._modelName = modelName
    this._projectionModel = projectionModel
    this._shards = WeightsProvider.expandGGUFIntoShards(this._modelName)
    this.weightsProvider = new WeightsProvider(loader, this.logger)
    this._hasActiveResponse = false
    this._jobInProgress = false
    this._defaultFinetuneParams = finetuningParams ?? null
    this._lastJobResult = Promise.resolve()
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
      const shouldDisableFlashAttn = this._defaultFinetuneParams !== null
      if (shouldDisableFlashAttn) {
        const hasFlashSetting = Object.prototype.hasOwnProperty.call(configForLoad, 'flash_attn')
        const requestedValue = hasFlashSetting ? configForLoad.flash_attn : undefined
        if (requestedValue !== 'off') {
          configForLoad.flash_attn = 'off'
        }
      }

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

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Local file or directory path
   * @param {Object} configurationParams.settings - LLM-specific settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon (configurationParams) {
    this.logger.info(
      'Creating Llama interface with configuration:',
      configurationParams
    )
    const binding = require('./binding')

    const originalLogger = this.logger
    const originalInfo = originalLogger && typeof originalLogger.info === 'function'
      ? originalLogger.info.bind(originalLogger)
      : null

    const shouldSuppressMessage = (args) => {
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

    const filteredLogger = originalLogger ? Object.create(Object.getPrototypeOf(originalLogger)) : {}
    Object.assign(filteredLogger, originalLogger)

    const originalWarn = originalLogger && typeof originalLogger.warn === 'function'
      ? originalLogger.warn.bind(originalLogger)
      : null

    filteredLogger.info = (...args) => {
      if (shouldSuppressMessage(args)) return
      if (originalInfo) {
        return originalInfo.apply(originalLogger, args)
      }
    }

    filteredLogger.warn = (...args) => {
      if (shouldSuppressMessage(args)) return
      if (originalWarn) {
        return originalWarn.apply(originalLogger, args)
      }
    }

    const originalLoggerRef = this.logger
    this.logger = filteredLogger

    const originalOutputCb = this._outputCallback?.bind(this)
    this._outputCallback = (instance, eventType, jobId, data, extra) => {
      const finetuneStatus = (
        data &&
        typeof data === 'object' &&
        data.op === 'finetune' &&
        typeof data.status === 'string'
      )
        ? data.status
        : null
      if (finetuneStatus && this._finetuneCompletionResolve) {
        this._finetuneActive = false
        this._finetuneCompletionResolve(finetuneStatus)
        this._finetuneCompletionResolve = null
        return
      }
      if (eventType === 'Error' && this._finetuneCompletionResolve) {
        this._finetuneActive = false
        this._finetuneCompletionResolve('ERROR')
        this._finetuneCompletionResolve = null
      }

      if (eventType === 'LogMsg') {
        const logMsg = typeof data === 'string' ? data : (data?.message || JSON.stringify(data))
        originalLoggerRef?.info?.(logMsg)
        return
      }
      if (eventType === 'Output' && typeof data === 'string') {
        const dataStr = data
        if (dataStr.includes('data=') && (dataStr.includes('loss=') || dataStr.includes('train:'))) {
          process.stdout.write(dataStr)
          return
        }
      }
      if (originalOutputCb) {
        return originalOutputCb(instance, eventType, jobId, data, extra)
      }
    }

    return new LlamaInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    if (typeof data === 'object' && data !== null && 'TPS' in data) {
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', data, null)
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      data.op === 'finetune' &&
      typeof data.status === 'string'
    ) {
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', data, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (typeof data === 'string') {
      mappedEvent = 'Output'
    }

    return this._outputCallback(addon, mappedEvent, 'job', data, error)
  }

  /**
   * Cancel the current task (or pause finetuning if finetune is running).
   */
  async cancel () {
    if (!this.addon) {
      throw new Error('Addon not initialized')
    }
    await this.addon.cancel()
  }

  /**
   * Unload model safely by cancelling and clearing pending jobs.
   * @returns {Promise<void>}
   */
  async unload () {
    return await this._withExclusiveRun(async () => {
      try {
        await this.cancel()
      } catch (_) {}
      const currentJobResponse = this._jobToResponse.get('OnlyOneJob')
      if (currentJobResponse) {
        currentJobResponse.failed(new Error('Model was unloaded'))
        this._deleteJobMapping('job')
      }
      this._hasActiveResponse = false
      await super.unload()
    })
  }

  /**
   * Internal method to start inference with a text prompt.
   * @param {Message[]} prompt - Input prompt array of messages
   * @returns {Promise<QvacResponse>} A QvacResponse representing the inference job
   */
  async _runInternal (prompt) {
    return this._withExclusiveRun(async () => {
      if (this._hasActiveResponse) {
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }

      this.logger.info('Starting inference with prompt:', prompt)
    return this._withExclusiveRun(async () => {
      const textMessages = []
      let mediaData = null

      for (const message of prompt) {
        if (message.role === 'user' &&
            message.type === 'media' &&
            message.content instanceof Uint8Array) {
          mediaItems.push(message.content)
          textMessages.push({ ...message, content: '' })
        } else {
          textMessages.push(message)
        }
      }

      const promptMessages = []

      for (const mediaData of mediaItems) {
        promptMessages.push({ type: 'media', content: mediaData })
      }

      promptMessages.push({ type: 'text', input: JSON.stringify(textMessages) })

      const response = this._createResponse('OnlyOneJob')

      // addon-cpp C++ guarantees no events will be generated
      // until job is fully accepted. This means even if trying
      // to queue a job fails right now as not accepted,
      // it will not generate events.
      //
      // If any unexpected exception is thrown (e.g. in the C++ code)
      // it will unwind here and the job will not be accepted.
      let accepted
      this._jobInProgress = true
      try {
        accepted = await this.addon.runJob(promptMessages)
      } catch (err) {
        this._deleteJobMapping('OnlyOneJob')
        response.failed(err)
        throw err
      }

      this._hasActiveResponse = true
      const finalized = response.await().finally(() => { this._hasActiveResponse = false })
      finalized.catch(() => {})
      response.await = () => finalized
      const response = this._createResponse('job')

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

    const params = finetuningOptions ?? this._defaultFinetuneParams
    if (!params) {
      throw new Error(
        'Finetuning parameters are required but not provided. Call finetune(opts) first; use finetune() with no args to resume from a pause.'
      )
    }
    if (finetuningOptions != null) {
      this._defaultFinetuneParams = params
    }
    const paramsToSend = normalizeFinetuneParams(params)
    this.logger?.info?.('finetune() called')
    this.logger?.info?.('Finetuning parameters:', params)

    if (this._finetuneActive) {
      throw new Error(RUN_QUEUE_BUSY_ERROR)
    }

    let resolveCompletion
    let rejectCompletion
    const completionPromise = new Promise((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    this._finetuneCompletionResolve = resolveCompletion

    const handle = {
      await: () => completionPromise.then(status => ({ status }))
    }

    return this._withExclusiveRun(async () => {
      this._finetuneActive = true
      try {
        await this.addon.finetune(paramsToSend)
        return handle
      } catch (err) {
        this._finetuneActive = false
        this._finetuneCompletionResolve = null
        rejectCompletion(err)
        throw err
      }
    })
  }
}

module.exports = LlmLlamacpp
