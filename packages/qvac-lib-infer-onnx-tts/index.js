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
    // Supertone / Supertonic (official 4-ONNX + unicode + voice_styles JSON)
    modelDir,
    textEncoderPath,
    durationPredictorPath,
    vectorEstimatorPath,
    vocoderPath,
    unicodeIndexerPath,
    ttsConfigPath,
    voiceStyleJsonPath,
    voiceName,
    speed,
    numInferenceSteps,
    supertonicMultilingual,
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

    const hasSupertonicPaths =
      (textEncoderPath != null && textEncoderPath !== '') ||
      (durationPredictorPath != null && durationPredictorPath !== '') ||
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
      this._supertonicMultilingual = supertonicMultilingual !== false
      if (modelDir) {
        const onnx = path.join(modelDir, 'onnx')
        this._textEncoderPath = path.join(onnx, 'text_encoder.onnx')
        this._durationPredictorPath = path.join(onnx, 'duration_predictor.onnx')
        this._vectorEstimatorPath = path.join(onnx, 'vector_estimator.onnx')
        this._vocoderPath = path.join(onnx, 'vocoder.onnx')
        this._unicodeIndexerPath = path.join(onnx, 'unicode_indexer.json')
        this._ttsConfigPath = path.join(onnx, 'tts.json')
        this._voiceStyleJsonPath = path.join(modelDir, 'voice_styles', `${this._voiceName.replace(/\.json$/i, '')}.json`)
      } else {
        this._textEncoderPath = textEncoderPath
        this._durationPredictorPath = durationPredictorPath
        this._vectorEstimatorPath = vectorEstimatorPath
        this._vocoderPath = vocoderPath
        this._unicodeIndexerPath = unicodeIndexerPath
        this._ttsConfigPath = ttsConfigPath
        this._voiceStyleJsonPath = voiceStyleJsonPath
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
    return {
      modelDir: baseDir,
      textEncoderPath: this._resolvePath(this._textEncoderPath),
      durationPredictorPath: this._resolvePath(this._durationPredictorPath),
      vectorEstimatorPath: this._resolvePath(this._vectorEstimatorPath),
      vocoderPath: this._resolvePath(this._vocoderPath),
      unicodeIndexerPath: this._resolvePath(this._unicodeIndexerPath),
      ttsConfigPath: this._resolvePath(this._ttsConfigPath),
      voiceStyleJsonPath: this._voiceStyleJsonPath
        ? this._resolvePath(this._voiceStyleJsonPath)
        : '',
      voiceName: this._voiceName || 'F1',
      language: this._config?.language || 'en',
      speed: String(this._speed),
      numInferenceSteps: String(this._numInferenceSteps),
      supertonicMultilingual: this._supertonicMultilingual
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
          this._textEncoderPath,
          this._durationPredictorPath,
          this._vectorEstimatorPath,
          this._vocoderPath,
          this._unicodeIndexerPath,
          this._ttsConfigPath,
          this._voiceStyleJsonPath
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
