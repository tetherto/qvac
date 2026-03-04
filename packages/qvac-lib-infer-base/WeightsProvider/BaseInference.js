'use strict'

const QvacLogger = require('@qvac/logging')
const { platform } = require('bare-os')
const { QvacInferenceBaseError, ERR_CODES } = require('../src/error')
const QvacResponse = require('../src/QvacResponse')

const platformDefinitions = {
  android: 'vulkan',
  darwin: 'metal',
  ios: 'metal',
  win32: 'vulkan-32',
  linux: 'vulkan'
}

/**
 * Base class for inference client implementations
 * @param {Object} opts - Configuration options
 * @param {boolean} [exclusiveRun=false] - Whether to use exclusive run queue for inference operations.
 */
class BaseInference {
  constructor ({ opts = {}, ...args }) {
    this.opts = opts
    this.logger = new QvacLogger(args?.logger)
    this._jobToResponse = new Map()
    this._runQueueWaiter = Promise.resolve()
    this.exclusiveRun = !!args.exclusiveRun

    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }
  }

  /**
   * Identifies which model API should be used on current environment
   */
  getApiDefinition () {
    const definition = platformDefinitions[platform()]
    const api = definition ?? 'vulkan'
    this.logger.debug(
      `Using API definition: ${api} for platform: ${platform()}`
    )
    return api
  }

  /**
   * Returns the current state of the inference client.
   * @return{ {configLoaded: boolean, weightsLoaded: boolean, destroyed: boolean } }
   */
  getState () {
    return this.state
  }

  /**
   * Supplies model and all the required files to the addon
   */
  async load (...args) {
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }

    await this._load(...args)
    this.state.configLoaded = true
  }

  async _load () {
    throw new QvacInferenceBaseError({ code: ERR_CODES.NOT_IMPLEMENTED, adds: '_load' })
  }

  async downloadWeights (onDownloadProgress, opts = {}) {
    return this._downloadWeights(onDownloadProgress, opts)
  }

  async _downloadWeights () {
    throw new QvacInferenceBaseError({ code: ERR_CODES.NOT_IMPLEMENTED, adds: '_downloadWeights' })
  }

  /**
   * Runs the process of inference output for a given input
   * Automatically wraps _runInternal with _withExclusiveRun when exclusiveRun is true
   */
  async run (input) {
    if (!this._runInternal) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.NOT_IMPLEMENTED,
        adds: '_runInternal'
      })
    }

    if (this.exclusiveRun) {
      return await this._withExclusiveRun(() => this._runInternal(input))
    }

    return await this._runInternal(input)
  }

  /**
   * Unloads the configuration and weights from the memory.
   */
  async unload () {
    if (!this.addon?.unload) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'unload'
      })
    }

    await this.addon.unload()

    this.state.configLoaded = false
    this.state.weightsLoaded = false
  }

  /**
   * Pauses the inference process
   */
  async pause () {
    if (!this.addon?.pause) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'pause'
      })
    }
    await this.addon.pause()
  }

  /**
   * Unpauses the inference process
   */
  async unpause () {
    if (!this.addon?.activate) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'activate'
      })
    }
    await this.addon.activate()
  }

  /**
   * Stops the inference process
   */
  async stop () {
    if (!this.addon?.stop) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'stop'
      })
    }
    await this.addon.stop()
  }

  /**
   * Ensures exclusive execution of async functions in a queue
   * @param {Function} fn - The async function to execute exclusively
   * @returns {Promise} The result of the executed function
   */
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
   * Cancels a specific job by its ID
   * @param {string} jobId - The identifier of the job to cancel
   */
  async cancel (jobId) {
    if (!this.addon) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_NOT_INITIALIZED
      })
    }

    if (!this.addon.cancel) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'cancel'
      })
    }

    if (!this.addon.activate) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'activate'
      })
    }

    await this.stop()
    await this.addon.cancel(jobId)
    await this.addon.activate()
  }

  /**
   * Gets the current status
   */
  async status () {
    if (!this.addon?.status) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'status'
      })
    }
    return await this.addon.status()
  }

  /**
   * Saves job to response mapping
   */
  _saveJobToResponseMapping (jobId, response) {
    this._jobToResponse.set(jobId, response)
  }

  /**
   * Deletes job mapping
   */
  _deleteJobMapping (jobId) {
    this._jobToResponse.delete(jobId)
  }

  /**
   * Unload the model and all the resources associated with it. Making the model unusable.
   * @returns {Promise<void>} - A promise that resolves when the model is fully destroyed.
   */
  async destroy () {
    if (!this.addon?.destroyInstance) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED,
        adds: 'destroyInstance'
      })
    }

    await this.addon.destroyInstance()

    this.state.configLoaded = false
    this.state.weightsLoaded = false
    this.state.destroyed = true
  }

  /**
   * Internal method to run inference
   */
  async _runInternal (input) {
    throw new QvacInferenceBaseError({ code: ERR_CODES.NOT_IMPLEMENTED, adds: '_runInternal' })
  }

  /**
   * Creates addon instance with the provided configuration and interface
   * @param {Object} AddonInterface - Interface class to instantiate
   * @param {...any} args - Arguments to pass to the interface constructor
   */
  _createAddon (AddonInterface, ...args) {
    if (!AddonInterface) {
      throw new QvacInferenceBaseError({ code: ERR_CODES.ADDON_INTERFACE_REQUIRED })
    }
    return new AddonInterface(...args)
  }

  /**
   * Creates a response instance for a job
   * @param {string} jobId - Job identifier
   * @returns {QvacResponse} Response instance with handlers
   */
  _createResponse (jobId) {
    if (!this.addon) {
      throw new QvacInferenceBaseError({ code: ERR_CODES.ADDON_NOT_INITIALIZED })
    }
    const response = new QvacResponse({
      cancelHandler: () => {
        return this.addon.cancel(jobId)
      },
      pauseHandler: () => {
        return this.addon.pause()
      },
      continueHandler: () => {
        return this.addon.activate()
      }
    })

    this._saveJobToResponseMapping(jobId, response)
    return response
  }

  /**
   * Handles output callbacks from the inference process
   */
  _outputCallback (addon, event, jobId, data, error) {
    const response = this._jobToResponse.get(jobId)
    if (!response) {
      this.logger.warn(`No response found for job ${jobId}`)
      return
    }

    if (event === 'Error') {
      this.logger.error(`Job ${jobId} failed with error: ${error}`)
      response.failed(error)
      this._deleteJobMapping(jobId)
    } else if (event === 'Output') {
      try {
        this.logger.debug(`Job ${jobId} produced output: ${dataAsString(data)}`)
      } catch (err) {
        if (err instanceof RangeError) {
          this.logger.debug(`Job ${jobId} produced output: [data too large]`)
        } else {
          throw err
        }
      }
      response.updateOutput(data)
    } else if (event === 'FinetuneProgress') {
      if (this.opts?.stats) {
        response.updateStats(data.stats)
      }
    } else if (event === 'JobEnded') {
      this.logger.info(`Job ${jobId} completed. Stats: ${JSON.stringify(data)}`)
      const isFinetuneTerminal = data && typeof data === 'object' && data.op === 'finetune' && typeof data.status === 'string'
      if (this.opts?.stats && !isFinetuneTerminal) {
        response.updateStats(data)
      }
      if (isFinetuneTerminal) {
        response.ended(data)
      } else {
        response.ended()
      }
      this._deleteJobMapping(jobId)
    } else {
      this.logger.debug(`Received event for job ${jobId}: ${event}`)
    }
  }
}

/**
 * Converts data to a string representation
 * @param {any} data - The data to convert to a string
 * @returns {string} - The string representation of the data
 */
function dataAsString (data) {
  if (!data) return ''
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return data.toString()
}

module.exports = BaseInference
