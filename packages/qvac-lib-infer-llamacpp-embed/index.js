'use strict'

const path = require('bare-path')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { BertInterface } = require('./addon')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * GGML client implementation for BERT GTE model
 */
class GGMLBert extends BaseInference {
  /**
   * Creates an instance of GGMLBert.
   * @constructor
   * @param {Object} params - arguments for model setup
   * @param {Object} args arguments for inference setup
   * @param {Object} config - environment specific inference setup configuration
   */
  constructor (
    { opts = {}, loader, logger = null, diskPath = '.', modelName },
    config = {}
  ) {
    super({ logger, opts })
    this._config = config
    this._diskPath = diskPath
    this._modelName = modelName
    // _shards will be null if the modelName is not a sharded file.
    this._shards = WeightsProvider.expandGGUFIntoShards(this._modelName)
    this.weightsProvider = new WeightsProvider(loader, this.logger)
    this._hasActiveResponse = false
  }

  async _load (closeLoader = false, reportProgressCallback) {
    this.logger.info('Starting model load')

    const configurationParams = {
      path: path.join(this._diskPath, this._modelName),
      config: this._config
    }

    this.logger.info('Creating addon with configuration:', configurationParams)
    this.addon = this._createAddon(configurationParams)

    if (this._shards !== null) {
      await this._loadWeights(reportProgressCallback)
    } else {
      await this.downloadWeights(reportProgressCallback, { closeLoader })
    }

    this.logger.info('Activating addon')
    await this.addon.activate()

    this.logger.info('Model load completed successfully')
  }

  /**
   * Download the model weight files and return the local path to the primary file.
   * @param {ProgressReportCallback} [onDownloadProgress] - Callback invoked with bytes downloaded
   * @param {Object} opts - Options for the download
   * @param {boolean} opts.closeLoader - Whether to close the loader when done
   * @returns {Promise<{filePath: string, completed: boolean, error: boolean}[]>} Local file path for the model weights
   */
  async _downloadWeights (onDownloadProgress, opts) {
    return await this.weightsProvider.downloadFiles(
      [this._modelName],
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
   * Cancel the current task.
   */
  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  /**
   * Unload the model and clear resources. Ensures any in-flight job is resolved as failed.
   * @returns {Promise<void>}
   */
  async unload () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      const currentJobResponse = this._jobToResponse.get('OnlyOneJob')
      if (currentJobResponse) {
        // Make sure not to leak jobs to avoid "job already exists" errors after
        // loading the model again.
        currentJobResponse.failed(new Error('Model was unloaded'))
        this._deleteJobMapping('OnlyOneJob')
      }
      this._hasActiveResponse = false
      await super.unload()
    })
  }

  async _runInternal (text) {
    return this._withExclusiveRun(async () => {
      if (this._hasActiveResponse) {
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }

      this.logger.info('Starting inference embeddings for text:', text)

      // Detect arrays and set type: 'sequences' for direct vector passing
      // Otherwise use type: 'text' for string input
      const inputData = Array.isArray(text)
        ? { type: 'sequences', input: text }
        : { type: 'text', input: text }

      const response = this._createResponse('OnlyOneJob')

      // addon-cpp C++ guarantees no events will be generated until job is
      // fully accepted. If runJob throws or returns false, no events will be
      // generated for this job.
      let accepted
      try {
        accepted = await this.addon.runJob(inputData)
      } catch (error) {
        this._deleteJobMapping('OnlyOneJob')
        response.failed(error)
        throw error
      }
      if (!accepted) {
        this._deleteJobMapping('OnlyOneJob')
        response.failed(new Error(RUN_BUSY_ERROR_MESSAGE))
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }

      this._hasActiveResponse = true
      const finalized = response.await().finally(() => { this._hasActiveResponse = false })
      finalized.catch(() => {})
      response.await = () => finalized

      return response
    })
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Local file or directory path
   * @param {Object} configurationParams.settings - Bert-specific settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon (configurationParams) {
    this.logger.info(
      'Creating Bert interface with configuration:',
      configurationParams
    )
    const binding = require('./binding')
    return new BertInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    // Map C++ mangled type names to expected event names
    // Stats / job-ended: LLM uses tokens_per_second; embed uses total_tokens, total_time_ms, etc. (RuntimeStats)
    const isStatsData = typeof data === 'object' && data !== null && (
      'tokens_per_second' in data ||
      ('total_tokens' in data || 'total_time_ms' in data || 'batch_size' in data || 'context_size' in data)
    )
    if (isStatsData) {
      const runtimeStats = { ...data }
      if (runtimeStats.backendDevice === 0) {
        runtimeStats.backendDevice = 'cpu'
      } else if (runtimeStats.backendDevice === 1) {
        runtimeStats.backendDevice = 'gpu'
      }
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', runtimeStats, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (event.includes('Embeddings')) {
      mappedEvent = 'Output'
    }
    return this._outputCallback(addon, mappedEvent, 'OnlyOneJob', data, error)
  }
}

module.exports = GGMLBert
