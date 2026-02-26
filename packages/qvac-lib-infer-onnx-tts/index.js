'use strict'

const { platform } = require('bare-os')
const path = require('bare-path')
const { TTSInterface } = require('./tts')
const InferBase = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')

// Engine types
const ENGINE_CHATTERBOX = 'chatterbox'
const ENGINE_SUPERTONIC = 'supertonic'

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

    this._lazySessionLoading = lazySessionLoading != null
      ? lazySessionLoading
      : platform() === 'ios'

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

    console.log('[TTS] Engine type:', this._engineType)
    console.log('[TTS] Language:', this._config?.language || 'en')

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

    this.addon = this._createAddon(ttsParams, this._outputCallback.bind(this), this._logger)
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
   * @param {Object} logger - Logger instance
   * @returns {TTSInterface} The instantiated addon interface
   */
  _createAddon (configurationParams, outputCb, logger) {
    const binding = require('./binding')
    return new TTSInterface(binding, configurationParams, outputCb, logger)
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
    if (this.addon) {
      return this.addon.destroyInstance()
    }
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
