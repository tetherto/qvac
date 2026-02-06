'use strict'

const path = require('bare-path')

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { LlamaInterface } = require('./addon')

const noop = () => { }

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
    this._runQueueWaiter = Promise.resolve()
    this._defaultFinetuneParams = finetuningParams ?? null
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
      this.addon = this._createAddon(configurationParams, this._defaultFinetuneParams)

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
  _createAddon (configurationParams, finetuningParams = null) {
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
    
    // BaseInference._outputCallback uses logger.warn() for "No response found for job"
    filteredLogger.warn = (...args) => {
      if (shouldSuppressMessage(args)) return
      if (originalWarn) {
        return originalWarn.apply(originalLogger, args)
      }
    }
    
    const originalLoggerRef = this.logger
    this.logger = filteredLogger
    
    const transitionCb = this.logger && typeof this.logger.info === 'function'
      ? this.logger.info.bind(this.logger)
      : null

    const originalOutputCb = this._outputCallback?.bind(this)
    this._outputCallback = (instance, eventType, jobId, data, extra) => {
      if (typeof data === 'string') {
        try {
          const obj = JSON.parse(data)
          if (obj?.type === 'FinetuneComplete' && this._finetuneCompletionResolve) {
            this._finetuneCompletionResolve(obj.status)
            if ((obj.status === 'IDLE' || obj.status === 'ERROR')) {
              this.addon?.resolvePauseComplete?.()
            }
            return
          }
          if (obj?.type === 'FinetunePaused') {
            this.addon?.resolvePauseComplete?.()
            if (this._finetuneCompletionResolve) {
              this._finetuneCompletionResolve('PAUSED')
            }
            return
          }
        } catch (_) {}
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

    const wrappedOutputCb = this._outputCallback

    return new LlamaInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this),
      wrappedOutputCb,
      transitionCb,
      finetuningParams
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    if (typeof data === 'object' && data !== null && 'TPS' in data) {
      return this._outputCallback(addon, 'JobEnded', 'job', data, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (typeof data === 'string') {
      mappedEvent = 'Output'
    }

    return this._outputCallback(addon, mappedEvent, 'job', data, error)
  }

  async _withExclusiveRun (fn) {
    const prev = this._runQueueWaiter || Promise.resolve()
    let release
    this._runQueueWaiter = new Promise(resolve => { release = resolve })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Internal method to start inference with a text prompt.
   * @param {Message[]} prompt - Input prompt array of messages
   * @returns {Promise<QvacResponse>} A QvacResponse representing the inference job
   */
  async _runInternal (prompt) {
    this.logger.info('Starting inference with prompt:', prompt)
    return this._withExclusiveRun(async () => {
      // Separate media messages from text messages
      const textMessages = []
      let mediaData = null

      for (const message of prompt) {
        if (message.role === 'user' &&
            message.type === 'media' &&
            message.content instanceof Uint8Array) {
          if (mediaData !== null) {
            throw new Error('Only one media message is supported at the moment')
          }
          mediaData = message.content
          // Keep the message as a placeholder marker (with empty content) for tokenization
          textMessages.push({ ...message, content: '' })
        } else {
          textMessages.push(message)
        }
      }

      const promptMessages = []

      // Send media first if present
      if (mediaData) {
        promptMessages.push({ type: 'media', content: mediaData })
      }

      // Send text messages
      promptMessages.push({ type: 'text', input: JSON.stringify(textMessages) })
      await this.addon.runJob(promptMessages)

      // Only one job is supported at the moment, with hardcoded jobId 'job'
      const response = this._createResponse('job')

      this.logger.info('Inference job started successfully')

      return response
    })
  }

  async finetune (finetuningOptions = undefined, options = {}) {
    if (arguments.length === 1 &&
        finetuningOptions &&
        typeof finetuningOptions === 'object' &&
        finetuningOptions.resume === true &&
        Object.keys(finetuningOptions).length === 1) {
      options = finetuningOptions
      finetuningOptions = undefined
    }
    options = options ?? {}
    const { resume = false } = options
    const params = finetuningOptions ?? this._defaultFinetuneParams
    if (!resume && !params) {
      throw new Error('Finetuning parameters are required but not provided.')
    }
    if (resume && !this._defaultFinetuneParams) {
      throw new Error('No stored finetuning parameters. Call finetune(opts) first before pausing.')
    }

    if (!resume) {
      this._defaultFinetuneParams = params
    }
    this.logger?.info?.(resume ? 'finetune() called (resume)' : 'finetune() called')
    this.logger?.info?.('Finetuning parameters:', params ?? this._defaultFinetuneParams)

    if (!this.addon) {
      this.logger?.info?.('Addon not loaded, calling load()...')
      await this.load()
      this.logger?.info?.('Addon loaded')
    }

    return this._withExclusiveRun(async () => {
      let resolveCompletion
      this._finetuneCompletionPromise = new Promise((resolve) => {
        resolveCompletion = resolve
      })
      this._finetuneCompletionResolve = resolveCompletion
      try {
        if (resume) {
          this.logger?.info?.('Calling addon.activate() to resume...')
          await this.addon.activate()
        } else {
          this.logger?.info?.('Calling addon.finetune()...')
          await this.addon.finetune(params)
        }
        this.logger?.info?.('Waiting for completion...')
        const finalStatus = await this._waitForFinetuneCompletion()
        this.logger?.info?.(`Finetuning completed with status: ${finalStatus}`)
        return { status: finalStatus }
      } finally {
        this._finetuneCompletionResolve = null
      }
    })
  }

  async _waitForFinetuneCompletion ({ timeoutMs = 100000000000 } = {}) {
    let timeoutId
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Time out')), timeoutMs)
    })
    try {
      return await Promise.race([
        this._finetuneCompletionPromise,
        timeoutPromise
      ])
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Pause finetuning. Saves checkpoint and pauses training.
   * @returns {Promise<void>}
   */
  async pauseFinetune () {
    if (!this.addon) {
      throw new Error('Addon not initialized')
    }
    if (!this.addon.isFinetuningRunning()) {
      throw new Error('Finetuning not running')
    }
    await this.addon.pause()
  }

}

module.exports = LlmLlamacpp
