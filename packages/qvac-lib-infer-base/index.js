'use strict'

let diagnostics
try { diagnostics = require('@qvac/diagnostics') } catch (e) { diagnostics = null }

const QvacLogger = require('@qvac/logging')
const { platform } = require('bare-os')
const path = require('bare-path')
const ProgressReport = require('./src/utils/progressReport')
const { QvacInferenceBaseError, ERR_CODES } = require('./src/error')
const QvacResponse = require('./src/QvacResponse')

const platformDefinitions = {
  android: 'vulkan',
  darwin: 'metal',
  ios: 'metal',
  win32: 'vulkan-32',
  linux: 'vulkan'
}

/**
 * Base class for inference client implementations
 */
class BaseInference {
  constructor ({ opts = {}, loader = null, ...args }) {
    this.opts = opts
    this.logger = new QvacLogger(args?.logger)
    this.loader = loader
    this._jobToResponse = new Map()

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

    if (diagnostics && this._packageName) {
      diagnostics.registerAddon({
        name: this._packageName,
        version: this._packageVersion || 'unknown',
        getDiagnostics: () => this._getDiagnosticsJSON ? this._getDiagnosticsJSON() : '{}'
      })
    }
  }

  async _load () {
    throw new QvacInferenceBaseError({ code: ERR_CODES.NOT_IMPLEMENTED, adds: '_load' })
  }

  /**
   * Loads the model weights from the provided loader.
   * @param loader - loader to fetch model weights from.
   * @param close - Optional boolean to close the loader after it finish (default: false).
   * @param reportProgressCallback - Optional callback function for reporting progress.
   * @returns {Promise<void>} - A promise that resolves when the weights are fully loaded.
   */
  async loadWeights (loader, close = false, reportProgressCallback) {
    // Call internal _loadWeights method if it exists
    await this._loadWeights(loader, close, reportProgressCallback)

    this.state.weightsLoaded = true
  }

  async _loadWeights (loader, close = false, reportProgressCallback) {
    this.logger.debug('No _loadWeights method defined, skipping weight loading')
  }

  /**
   * Unloads weights from the memory.
   * @returns {Promise<void>} - A promise that resolves when the weights are unloaded.
   */
  async unloadWeights () {
    // Call internal _unloadWeights method if it exists
    await this._unloadWeights()

    this.state.weightsLoaded = false
  }

  async _unloadWeights () {
    this.logger.debug(
      'No _unloadWeights method defined, skipping weight unloading'
    )
  }

  /**
   * Downloads the model weights from the provided loader.
   * @param source - source to fetch model weights from.
   * @param diskPath - path to download the weights to.
   * @param reportProgressCallback - Optional callback function for reporting progress.
   * @returns {Promise<void>} - A promise that resolves when the weights are fully downloaded.
   */
  async downloadWeights (source, diskPath = '', reportProgressCallback) {
    await this._downloadWeights(source, diskPath, reportProgressCallback)
  }

  async _downloadWeights (source, diskPath = '', reportProgressCallback) {
    this.logger.debug(
      'No _downloadWeights method defined, skipping weight downloading'
    )
  }

  /**
   * Initializes progress reporting for model loading
   */
  async initProgressReport (weightFiles, callbackFunction) {
    if (this.loader?.getFileSize && callbackFunction) {
      this.logger.info(
        `Initializing progress report for ${weightFiles.length} weight files`
      )
      const filesizeMapping = {}

      await Promise.all(
        weightFiles.map(async filepath => {
          const currentFileName = path.basename(filepath)
          this.logger.debug(`Getting file size for: ${currentFileName}`)
          const currentFileSize = await this.loader.getFileSize(filepath)
          filesizeMapping[currentFileName] = currentFileSize
          this.logger.debug(
            `File size for ${currentFileName}: ${currentFileSize} bytes`
          )
        })
      )

      const totalSize = Object.values(filesizeMapping).reduce(
        (sum, size) => sum + size,
        0
      )
      this.logger.info(
        `Progress report initialized. Total size to download: ${totalSize} bytes across ${weightFiles.length} files`
      )
      const progressReport = new ProgressReport(
        filesizeMapping,
        callbackFunction
      )
      return progressReport
    } else {
      if (!this.loader?.getFileSize) {
        this.logger.warn(
          'Progress report initialization skipped - loader missing getFileSize capability'
        )
      }
      if (!callbackFunction) {
        this.logger.warn(
          'Progress report initialization skipped - no callback function provided'
        )
      }
      return null
    }
  }

  /**
   * Deletes local model files
   */
  async delete () {
    if (!this.loader?.deleteLocal) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.LOAD_NOT_IMPLEMENTED,
        adds: 'deleteLocal'
      })
    }
    await this.loader.deleteLocal()
  }

  /**
   * Runs the process of inference output for a given input
   */
  async run (input) {
    if (!this._runInternal) {
      throw new QvacInferenceBaseError({
        code: ERR_CODES.NOT_IMPLEMENTED,
        adds: '_runInternal'
      })
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

    if (diagnostics && this._packageName) {
      diagnostics.unregisterAddon(this._packageName)
    }
  }

  /**
   * Gets configuration files content
   */
  async _getConfigs () {
    const configs = {}
    for (const path of this._getConfigPathNames()) {
      configs[path] = await this._getFileContent(path)
    }
    return configs
  }

  /**
   * Gets file content from loader
   */
  async _getFileContent (filepath) {
    if (!this.loader) {
      this.logger.error('Failed to get file content - loader not initialized')
      throw new QvacInferenceBaseError({ code: ERR_CODES.LOADER_NOT_FOUND })
    }

    this.logger.debug(`Reading file content from: ${filepath}`)
    const content = []
    const cStream = await this.loader.getStream(filepath)
    for await (const c of cStream) {
      content.push(c)
    }
    return Buffer.concat(content)
  }

  /**
   * Gets configuration file paths
   */
  _getConfigPathNames () {
    throw new QvacInferenceBaseError({
      code: ERR_CODES.NOT_IMPLEMENTED,
      adds: '_getConfigPathNames'
    })
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
    return new QvacResponse({
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
      this.logger.debug(`Job ${jobId} produced output: ${dataAsString(data)}`)
      response.updateOutput(data)
    } else if (event === 'JobEnded') {
      this.logger.info(`Job ${jobId} completed. Stats: ${JSON.stringify(data)}`)
      if (this.opts?.stats) {
        response.updateStats(data)
      }
      response.ended()
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
module.exports.QvacResponse = QvacResponse
