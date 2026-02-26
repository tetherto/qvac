'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const exclusiveRunQueue = require('@qvac/infer-base/src/exclusiveRunQueue')
const { BertInterface } = require('./addon')

/** Max ms to wait for the previous job to finish before throwing. */
const PREVIOUS_JOB_WAIT_MS = 30
const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

async function streamShardsToAddon (filePaths, addon) {
  for (const filePath of filePaths) {
    const filename = path.basename(filePath)
    const stream = fs.createReadStream(filePath)
    for await (const chunk of stream) {
      await addon.loadWeights({ filename, chunk, completed: false })
    }
    await addon.loadWeights({ filename, chunk: null, completed: true })
  }
}

/**
 * GGML client implementation for BERT GTE model
 */
class GGMLBert extends BaseInference {
  /**
   * @param {Object} params
   * @param {{ model: string[] }} params.files - absolute paths to model file(s)
   * @param {string} [params.config] - environment specific inference config
   * @param {Object} [params.logger]
   * @param {Object} [params.opts]
   */
  constructor ({ files, config = '', logger = null, opts = {} }) {
    super({ logger, opts })
    this._config = config
    this._files = files
    this._withExclusiveRun = exclusiveRunQueue()
    this._lastJobResult = Promise.resolve()
  }

  async _load () {
    this.logger.info('Starting model load')

    const modelPath = this._files.model.length > 1
      ? this._files.model.find(f => f.endsWith('.gguf')) || this._files.model[0]
      : this._files.model[0]

    const configurationParams = { path: modelPath, config: this._config }

    this.logger.info('Creating addon with configuration:', configurationParams)
    this.addon = this._createAddon(configurationParams)

    if (this._files.model.length > 1) {
      await streamShardsToAddon(this._files.model, this.addon)
    }

    this.logger.info('Activating addon')
    await this.addon.activate()

    this.logger.info('Model load completed successfully')
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
      await super.unload()
    })
  }

  async _runInternal (text) {
    return this._withExclusiveRun(async () => {
      this.logger.info('Starting inference embeddings for text:', text)

      // Detect arrays and set type: 'sequences' for direct vector passing
      // Otherwise use type: 'text' for string input
      const inputData = Array.isArray(text)
        ? { type: 'sequences', input: text }
        : { type: 'text', input: text }

      // Make sure all events from previous one are done and will not
      // affect our new job. addon-cpp C++ guarantees every accepted job will
      // end with output or exception after finishing processing.
      // - If timeout is hit, exception should surface to avoid infinite await.
      // - It is expected that we briefly wait for the previous job to settle
      //   before throwing a busy error.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(RUN_BUSY_ERROR_MESSAGE))
        }, PREVIOUS_JOB_WAIT_MS)
        this._lastJobResult
          .then(() => { clearTimeout(timer); resolve() })
          .catch(() => { clearTimeout(timer); resolve() })
      })

      // At this point, previous job is not using 'OnlyOneJob'
      // slot anymore, so we can safely overwrite it with new response.
      // Create response before running the job so any events right after
      // successful runJob are not lost.
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

      // Store the finish promise so the next run can wait on it.
      this._lastJobResult = response.await()

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
      return this._outputCallback(addon, 'JobEnded', 'OnlyOneJob', data, null)
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
