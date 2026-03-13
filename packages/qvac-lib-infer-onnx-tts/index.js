'use strict'

const { platform } = require('bare-os')
const path = require('bare-path')
const { TTSInterface } = require('./tts')
const { QvacErrorAddonTTS, ERR_CODES } = require('./lib/error')
const InferBase = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')

// Engine types
const ENGINE_CHATTERBOX = 'chatterbox'
const ENGINE_SUPERTONIC = 'supertonic'
const ONLY_ONE_JOB_ID = 'OnlyOneJob'

function createBusyJobError () {
  return new QvacErrorAddonTTS({ code: ERR_CODES.JOB_ALREADY_RUNNING })
}

class ONNXTTS extends InferBase {
  constructor ({
    tokenizerPath,
    speechEncoderPath,
    embedTokensPath,
    conditionalDecoderPath,
    languageModelPath,
    referenceAudio,
    // Supertonic-specific (if provided, engine is Supertonic)
    modelDir,
    textEncoderPath,
    latentDenoiserPath,
    voiceDecoderPath,
    voicesDir,
    voiceName,
    speed,
    numInferenceSteps,
    lazySessionLoading,
    loader, cache, logger, ...args
  }, config = {}) {
    super(args)

    this._loader = loader
    this._weightsProvider = loader ? new WeightsProvider(loader, logger) : null
    this._cache = cache || '.'
    this._config = config
    this._logger = logger
    this._hasActiveResponse = false

    this._lazySessionLoading = lazySessionLoading != null
      ? lazySessionLoading
      : (platform() === 'ios' || platform() === 'android')

    const hasSupertonicPaths = (textEncoderPath != null && textEncoderPath !== '') ||
      (modelDir != null && modelDir !== '' && voiceName != null && voiceName !== '')
    this._engineType = hasSupertonicPaths ? ENGINE_SUPERTONIC : ENGINE_CHATTERBOX

    if (this._engineType === ENGINE_CHATTERBOX) {
      this._tokenizerPath = tokenizerPath
      this._speechEncoderPath = speechEncoderPath
      this._embedTokensPath = embedTokensPath
      this._conditionalDecoderPath = conditionalDecoderPath
      this._languageModelPath = languageModelPath
      this._referenceAudio = referenceAudio
    } else {
      this._modelDir = modelDir
      this._voiceName = voiceName ?? 'F1'
      this._speed = speed != null ? speed : 1
      this._numInferenceSteps = numInferenceSteps != null ? numInferenceSteps : 5
      if (modelDir) {
        this._tokenizerPath = path.join(modelDir, 'tokenizer.json')
        this._textEncoderPath = path.join(modelDir, 'onnx', 'text_encoder.onnx')
        this._latentDenoiserPath = path.join(modelDir, 'onnx', 'latent_denoiser.onnx')
        this._voiceDecoderPath = path.join(modelDir, 'onnx', 'voice_decoder.onnx')
        this._voicesDir = path.join(modelDir, 'voices')
      } else {
        this._tokenizerPath = tokenizerPath
        this._textEncoderPath = textEncoderPath
        this._latentDenoiserPath = latentDenoiserPath
        this._voiceDecoderPath = voiceDecoderPath
        this._voicesDir = voicesDir
      }
    }
  }

  async _load (closeLoader = false, reportProgressCallback) {
    await this._downloadWeights(reportProgressCallback, { closeLoader })

    this.logger.info('[TTS] Engine type:', this._engineType)
    this.logger.info('[TTS] Language:', this._config?.language || 'en')

    let ttsParams
    if (this._engineType === ENGINE_SUPERTONIC) {
      ttsParams = this._getSupertonicTtsParams()
    } else {
      ttsParams = {
        tokenizerPath: this._resolvePath(this._tokenizerPath),
        speechEncoderPath: this._resolvePath(this._speechEncoderPath),
        embedTokensPath: this._resolvePath(this._embedTokensPath),
        conditionalDecoderPath: this._resolvePath(this._conditionalDecoderPath),
        languageModelPath: this._resolvePath(this._languageModelPath),
        language: this._config?.language || 'en',
        useGPU: this._config?.useGPU || false,
        lazySessionLoading: this._lazySessionLoading
      }
      if (this._referenceAudio != null) {
        ttsParams.referenceAudio = this._referenceAudio
      }
    }

    this.addon = this._createAddon(ttsParams, this._addonOutputCallback.bind(this))
    await this.addon.activate()
  }

  _getSupertonicTtsParams () {
    const baseDir = this._modelDir
      ? this._resolvePath(this._modelDir)
      : ''
    const onnxDir = baseDir ? path.join(baseDir, 'onnx') : ''
    const voicesDir = this._voicesDir
      ? this._resolvePath(this._voicesDir)
      : (baseDir ? path.join(baseDir, 'voices') : '')
    return {
      modelDir: baseDir,
      tokenizerPath: this._tokenizerPath
        ? this._resolvePath(this._tokenizerPath)
        : (baseDir ? path.join(baseDir, 'tokenizer.json') : ''),
      textEncoderPath: this._textEncoderPath
        ? this._resolvePath(this._textEncoderPath)
        : (onnxDir ? path.join(onnxDir, 'text_encoder.onnx') : ''),
      latentDenoiserPath: this._latentDenoiserPath
        ? this._resolvePath(this._latentDenoiserPath)
        : (onnxDir ? path.join(onnxDir, 'latent_denoiser.onnx') : ''),
      voiceDecoderPath: this._voiceDecoderPath
        ? this._resolvePath(this._voiceDecoderPath)
        : (onnxDir ? path.join(onnxDir, 'voice_decoder.onnx') : ''),
      voicesDir,
      voiceName: this._voiceName || 'F1',
      language: this._config?.language || 'en',
      speed: String(this._speed),
      numInferenceSteps: String(this._numInferenceSteps)
    }
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {Function} outputCb - Callback for inference events
   * @returns {TTSInterface} The instantiated addon interface
   */
  _createAddon (configurationParams, outputCb) {
    const binding = require('./binding')
    return new TTSInterface(binding, configurationParams, outputCb)
  }

  _resolvePath (filePath) {
    if (!filePath) return ''
    if (this._loader) {
      return path.join(this._cache, filePath)
    }
    if (platform() === 'win32') {
      return '\\\\?\\' + path.resolve(filePath)
    }
    return path.resolve(filePath)
  }

  async _downloadWeights (reportProgressCallback, { closeLoader }) {
    if (!this._weightsProvider) {
      return
    }

    const files = this._engineType === ENGINE_SUPERTONIC
      ? [
          this._tokenizerPath,
          this._textEncoderPath,
          this._latentDenoiserPath,
          this._voiceDecoderPath,
          this._voicesDir ? path.join(this._voicesDir, this._voiceName + '.bin') : null
        ].filter(Boolean)
      : [
          this._tokenizerPath,
          this._speechEncoderPath,
          this._embedTokensPath,
          this._conditionalDecoderPath,
          this._languageModelPath
        ].filter(Boolean)

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
    await this.cancel()
    this._failAndClearActiveResponse('Model was unloaded')
    if (this.addon) {
      await this.addon.destroyInstance()
    }
    this.state.configLoaded = false
    this.state.weightsLoaded = false
  }

  async _runInternal (input) {
    if (this._hasActiveResponse) {
      throw createBusyJobError()
    }

    const response = this._createResponse(ONLY_ONE_JOB_ID)
    let accepted
    try {
      accepted = await this.addon.runJob({
        type: input.type || 'text',
        input: input.input
      })
    } catch (error) {
      this._deleteJobMapping(ONLY_ONE_JOB_ID)
      response.failed(error)
      throw error
    }

    if (!accepted) {
      this._deleteJobMapping(ONLY_ONE_JOB_ID)
      const busyError = createBusyJobError()
      response.failed(busyError)
      throw busyError
    }

    this._hasActiveResponse = true
    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch(() => {})
    response.await = () => finalized
    return response
  }

  _addonOutputCallback (addon, event, data, error) {
    if (typeof error === 'string' && error.length > 0) {
      return this._outputCallback(addon, 'Error', ONLY_ONE_JOB_ID, data, error)
    }

    if (data && typeof data === 'object' && data.outputArray) {
      return this._outputCallback(addon, 'Output', ONLY_ONE_JOB_ID, data, null)
    }

    if (
      data &&
      typeof data === 'object' &&
      ('totalTime' in data || 'audioDurationMs' in data || 'totalSamples' in data)
    ) {
      return this._outputCallback(addon, 'JobEnded', ONLY_ONE_JOB_ID, data, null)
    }

    return this._outputCallback(addon, event, ONLY_ONE_JOB_ID, data, error)
  }

  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  _failAndClearActiveResponse (reason) {
    const currentJobResponse = this._jobToResponse.get(ONLY_ONE_JOB_ID)
    if (currentJobResponse) {
      currentJobResponse.failed(new Error(reason))
      this._deleteJobMapping(ONLY_ONE_JOB_ID)
    }
    this._hasActiveResponse = false
  }

  /**
   * Reload the addon with new configuration parameters.
   * Supports changing both runtime parameters (language, useGPU) and model files.
   * @param {Object} newConfig - New configuration parameters
   * @param {string} [newConfig.language] - Language setting (defaults to 'en')
   * @param {boolean} [newConfig.useGPU] - Whether to use GPU (defaults to false)
   * @param {Function} [newConfig.reportProgressCallback] - Hook for download progress updates
   */
  async reload (newConfig = {}) {
    this.logger.debug('Reloading addon with new configuration', newConfig)

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

    let ttsParams
    if (this._engineType === ENGINE_SUPERTONIC) {
      ttsParams = this._getSupertonicTtsParams()
    } else {
      ttsParams = {
        tokenizerPath: this._resolvePath(this._tokenizerPath),
        speechEncoderPath: this._resolvePath(this._speechEncoderPath),
        embedTokensPath: this._resolvePath(this._embedTokensPath),
        conditionalDecoderPath: this._resolvePath(this._conditionalDecoderPath),
        languageModelPath: this._resolvePath(this._languageModelPath),
        language: this._config?.language || 'en',
        useGPU: this._config?.useGPU || false,
        lazySessionLoading: this._lazySessionLoading
      }
      if (this._referenceAudio != null) {
        ttsParams.referenceAudio = this._referenceAudio
      }
    }

    await this.cancel()
    this._failAndClearActiveResponse('Model was reloaded')

    if (this.addon) {
      await this.addon.destroyInstance()
    }
    this.addon = this._createAddon(ttsParams, this._addonOutputCallback.bind(this))
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
