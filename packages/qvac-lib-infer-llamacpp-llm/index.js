'use strict'

const path = require('bare-path')

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { LlamaInterface } = require('./addon')

const END_OF_INPUT = 'end of job'
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
  constructor ({ opts = {}, loader, logger = null, diskPath = '.', modelName, projectionModel }, config) {
    super({ logger, opts })
    this._config = config
    this._diskPath = diskPath
    this._modelName = modelName
    this._projectionModel = projectionModel
    // _shards will be null if the modelName is not a sharded file.
    this._shards = WeightsProvider.expandGGUFIntoShards(this._modelName)
    this.weightsProvider = new WeightsProvider(loader, this.logger)
    this._runQueueWaiter = Promise.resolve()
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
      const configurationParams = {
        path: path.join(this._diskPath, this._modelName),
        projectionPath: this._projectionModel ? path.join(this._diskPath, this._projectionModel) : '',
        config: this._config
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
    const binding = require('./binding')
    return new LlamaInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.logger.info.bind(this.logger)
    )
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
      // Process prompt to handle media content with user role
      const processedPrompt = prompt.map(message => {
        // Check if message has user role and media type with Uint8Array content
        if (message.role === 'user' &&
          message.type === 'media' &&
          message.content instanceof Uint8Array) {
          // Send media data as separate append call
          this.addon.append({ type: 'media', input: message.content })
            .catch(err => this.logger.error('Failed to send media data:', err))

          // Return modified message with empty string for media content
          return {
            ...message,
            content: ''
          }
        }

        return message
      })

      const serializedPrompt = JSON.stringify(processedPrompt)

      const jobId = await this.addon.append({ type: 'text', input: serializedPrompt })

      this.logger.info('Created inference job with ID:', jobId)

      const response = this._createResponse(jobId)
      await this.addon.append({ type: END_OF_INPUT })

      this.logger.info('Inference job started successfully')

      return response
    })
  }
}

module.exports = LlmLlamacpp
