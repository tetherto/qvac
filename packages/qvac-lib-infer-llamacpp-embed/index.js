'use strict'

const path = require('bare-path')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { BertInterface } = require('./addon')

const END_OF_INPUT = 'end of job'

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
    { opts = {}, loader, logger = null, diskPath = '.', modelName, exclusiveRun = true },
    config
  ) {
    super({ logger, opts, exclusiveRun })
    this._config = config
    this._diskPath = diskPath
    this._modelName = modelName
    // _shards will be null if the modelName is not a sharded file.
    this._shards = WeightsProvider.expandGGUFIntoShards(this._modelName)
    this.weightsProvider = new WeightsProvider(loader, this.logger)
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

  async _runInternal (text) {
    this.logger.info('Starting inference embeddings for text:', text)

    // Detect arrays and set type: 'sequences' for direct vector passing
    // Otherwise use type: 'text' for string input
    const inputData = Array.isArray(text)
      ? { type: 'sequences', input: text }
      : { type: 'text', input: text }

    const jobId = await this.addon.append(inputData)

    const response = this._createResponse(jobId)

    await this.addon.append({ type: END_OF_INPUT })

    return response
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
      this._outputCallback.bind(this),
      console.log
    )
  }
}

module.exports = GGMLBert
