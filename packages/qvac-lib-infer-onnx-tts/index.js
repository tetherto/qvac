'use strict'

const { platform } = require('bare-os')
const path = require('bare-path')
const { TTSInterface } = require('./tts')
const InferBase = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')

class ONNXTTS extends InferBase {
  constructor ({ mainModelUrl, configJsonPath, eSpeakDataPath, loader, cache, logger, ...args }, config = {}) {
    super(args)

    this._loader = loader
    this._weightsProvider = loader ? new WeightsProvider(loader, logger) : null
    this._cache = cache || '.'
    this._mainModelUrl = mainModelUrl
    this._configJsonPath = configJsonPath
    this._eSpeakDataPath = eSpeakDataPath
    this._config = config
    this._logger = logger

    // Tashkeel model is bundled with the addon
    this._tashkeelModelDir = path.join(__dirname, 'assets', 'tashkeel')
  }

  async _load (closeLoader = false, reportProgressCallback) {
    await this._downloadWeights(reportProgressCallback, { closeLoader })

    const tashkeelPath = this._getTashkeelModelDir(this._tashkeelModelDir)
    console.log('[TTS] Tashkeel model dir:', tashkeelPath)
    console.log('[TTS] Language:', this._config?.language || 'en')

    const ttsParams = {
      modelPath: this._getMainModelUrl(this._mainModelUrl),
      configJsonPath: this._getConfigPath(this._configJsonPath),
      eSpeakDataPath: this._getESpeakDataPath(this._eSpeakDataPath),
      tashkeelModelDir: tashkeelPath,
      language: this._config?.language || 'en',
      useGPU: this._config?.useGPU || false
    }

    this.addon = this._createAddon(ttsParams, this._outputCallback.bind(this), this._logger)
    await this.addon.activate()
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {Function} outputCb - Callback for inference events
   * @param {Object} logger - Logger instance
   * @returns {TTSInterface} The instantiated addon interface
   */
  _createAddon (configurationParams, outputCb, logger) {
    const binding = require('./binding')
    return new TTSInterface(binding, configurationParams, outputCb, logger)
  }

  _getMainModelUrl (mainModelUrl) {
    if (this._loader) {
      return path.join(this._cache, mainModelUrl)
    }
    if (platform() === 'win32') {
      return '\\\\?\\' + path.resolve(mainModelUrl)
    }
    return path.resolve(mainModelUrl)
  }

  _getConfigPath (configJsonPath) {
    if (this._loader) {
      return path.join(this._cache, configJsonPath)
    }
    if (platform() === 'win32') {
      return '\\\\?\\' + path.resolve(configJsonPath)
    }
    return path.resolve(configJsonPath)
  }

  _getESpeakDataPath (eSpeakDataPath) {
    if (platform() === 'win32') {
      return '\\\\?\\' + path.resolve(eSpeakDataPath)
    }

    return path.resolve(eSpeakDataPath)
  }

  _getTashkeelModelDir (tashkeelModelDir) {
    if (!tashkeelModelDir) {
      return ''
    }
    if (platform() === 'win32') {
      return '\\\\?\\' + path.resolve(tashkeelModelDir)
    }
    return path.resolve(tashkeelModelDir)
  }

  async _downloadWeights (reportProgressCallback, { closeLoader }) {
    if (!this._weightsProvider) {
      return
    }

    const files = [this._mainModelUrl, this._configJsonPath]

    this.logger.info('Loading weight files:', files)

    const result = await this._weightsProvider.downloadFiles(
      files,
      this._cache,
      {
        closeLoader,
        onDownloadProgress: reportProgressCallback
      }
    )
    this.logger.info('Weight files downloaded successfully', { files })
    return result
  }

  async unload () {
    return this.addon.destroyInstance()
  }

  async _runInternal (input) {
    const jobId = await this.addon.append({
      type: input.type || 'text',
      input: input.input
    })
    const response = this._createResponse(jobId)
    this._saveJobToResponseMapping(jobId, response)
    await this.addon.append({ type: 'end of job' })
    return response
  }

  /**
   * Reload the addon with new configuration parameters.
   * Supports changing both runtime parameters (language, useGPU) and model files.
   * @param {Object} newConfig - New configuration parameters
   * @param {string} [newConfig.mainModelUrl] - Path to new model file
   * @param {string} [newConfig.configJsonPath] - Path to new config JSON file
   * @param {string} [newConfig.eSpeakDataPath] - Path to eSpeak data directory
   * @param {string} [newConfig.language] - Language setting (defaults to 'en')
   * @param {boolean} [newConfig.useGPU] - Whether to use GPU (defaults to false)
   * @param {Function} [newConfig.reportProgressCallback] - Hook for download progress updates
   */
  async reload (newConfig = {}) {
    this.logger.debug('Reloading addon with new configuration', newConfig)

    // Update model paths if provided
    if (newConfig.mainModelUrl !== undefined) {
      this._mainModelUrl = newConfig.mainModelUrl
    }
    if (newConfig.configJsonPath !== undefined) {
      this._configJsonPath = newConfig.configJsonPath
    }
    if (newConfig.eSpeakDataPath !== undefined) {
      this._eSpeakDataPath = newConfig.eSpeakDataPath
    }

    // Update runtime config
    if (newConfig.language !== undefined) {
      this._config.language = newConfig.language
    }
    if (newConfig.useGPU !== undefined) {
      this._config.useGPU = newConfig.useGPU
    }

    // Download new weights if model changed and we have a loader
    if (this._weightsProvider && (newConfig.mainModelUrl || newConfig.configJsonPath)) {
      await this._downloadWeights(newConfig.reportProgressCallback, { closeLoader: false })
    }

    const ttsParams = {
      modelPath: this._getMainModelUrl(this._mainModelUrl),
      configJsonPath: this._getConfigPath(this._configJsonPath),
      eSpeakDataPath: this._getESpeakDataPath(this._eSpeakDataPath),
      tashkeelModelDir: this._getTashkeelModelDir(this._tashkeelModelDir),
      language: this._config?.language || 'en',
      useGPU: this._config?.useGPU || false
    }

    await this.addon.reload(ttsParams)
    await this.addon.activate()
  }

  static inferenceManagerConfig = {
    noAdditionalDownload: true
  }

  static getModelKey (params) {
    return 'onnx-tts'
  }
}

module.exports = ONNXTTS
