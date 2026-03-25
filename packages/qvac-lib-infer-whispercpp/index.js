'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')

const { WhisperInterface } = require('./whisper')
const { checkConfig } = require('./configChecker')
const { QvacErrorAddonWhisper, ERR_CODES } = require('./lib/error')

const END_OF_INPUT = 'end of job'

/**
 * GGML client implementation for the Whisper transcription model
 */
class TranscriptionWhispercpp extends BaseInference {
  /**
   * Creates an instance of WhisperClient.
   * @constructor
   * @param {Object} args - arguments for inference setup
   * @param {Object} config - environment-specific inference setup configuration
   */
  constructor (
    { loader, logger = null, modelName, vadModelName, diskPath, exclusiveRun = true, ...args },
    config
  ) {
    // Forward extra args (notably `opts`) to BaseInference so features like stats can be enabled.
    super({ logger, loader, exclusiveRun, ...args })

    this._diskPath = diskPath || ''
    this._modelName = modelName
    this._vadModelName = vadModelName || config.vad_model_path
    this._config = config
    this.weightsProvider = new WeightsProvider(loader, this.logger)

    this.params = config.whisperConfig
    this._hasActiveResponse = false

    this.logger.debug('TranscriptionWhispercpp constructor called', {
      params: this.params,
      config: this._config,
      diskPath: this._diskPath
    })

    this.validateModelFiles()
  }

  /**
   * Load model, weights, and activate addon.
   * @param {boolean} [closeLoader=false] - Close loader when done.
   * @param {Function} [reportProgressCallback] - Hook for progress updates.
   */
  async _load (closeLoader = false, reportProgressCallback) {
    this.logger.debug('Loader ready')

    await this.downloadWeights(reportProgressCallback, { closeLoader })

    const whisperConfig = {
      ...this.params,
      language: this.params.language || 'en',
      duration_ms: this.params.max_seconds ? this.params.max_seconds * 1000 : 0,
      temperature: this.params.temperature || 0.0,
      suppress_nst: this.params.suppress_nst ?? true,
      n_threads: this.params.n_threads || 0
    }

    // Remove SDK-level params that aren't valid for C++ addon
    delete whisperConfig.audio_format
    delete whisperConfig.contextParams
    delete whisperConfig.miscConfig
    delete whisperConfig.vadModelPath
    delete whisperConfig.vad_params

    // VAD model is required for whisper transcription
    const vadModelPath = this._config.vadModelPath || this._getVadModelFilePath()
    if (vadModelPath) {
      whisperConfig.vad_model_path = vadModelPath
      whisperConfig.vadParams = this.params.vad_params || { threshold: 0.6 }
    }

    const configurationParams = {
      contextParams: {
        model: this._config.path || this._getModelFilePath(),
        ...(this._config.contextParams || {})
      },
      whisperConfig,
      miscConfig: {
        caption_enabled: false,
        ...(this._config.miscConfig || {})
      },
      audio_format: this._config.audio_format || this.params.audio_format || 's16le'
    }

    // this entrypoint serves as the model configuration.
    // must contain whisperConfig, vadParams, and contextParams
    _checkParamsExists(configurationParams)
    this.addon = this._createAddon(configurationParams)

    // For whisper.cpp, the model file contains everything - no separate weight loading needed
    await this.addon.activate()
    this.logger.debug('Addon activated')
  }

  _getModelFilePath () {
    if (!this._modelName) {
      return ''
    }
    return path.join(this._diskPath, this._modelName)
  }

  _getVadModelFilePath () {
    return this._vadModelName ? path.join(this._diskPath, this._vadModelName) : null
  }

  async _runInternal (audioStream, opts = {}) {
    if (this.exclusiveRun && this._hasActiveResponse) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.JOB_ALREADY_RUNNING
      })
    }

    const normalizedAudioStream = this._normalizeAudioStream(audioStream)

    if (opts.streaming) {
      return this._runStreaming(normalizedAudioStream)
    }

    const jobId = await this.addon.append({
      type: 'audio',
      input: new Uint8Array()
    })

    const response = this._createResponse(jobId)
    this._hasActiveResponse = true
    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch(() => {})
    response.await = () => finalized

    this._handleAudioStream(normalizedAudioStream).catch((error) => {
      response.failed(error)
      this._deleteJobMapping(jobId)
    })
    return response
  }

  async _runStreaming (audioStream) {
    const vadModelPath = this._config.vadModelPath || this._getVadModelFilePath()
    if (!vadModelPath) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.VAD_MODEL_REQUIRED
      })
    }

    const vadParams = this.params?.vad_params || {}

    this.addon.startStreaming({
      vadModelPath,
      vadThreshold: vadParams.threshold || 0.5,
      minSilenceDurationMs: vadParams.min_silence_duration_ms || 500,
      minSpeechDurationMs: vadParams.min_speech_duration_ms || 250,
      maxSpeechDurationS: vadParams.max_speech_duration_s || 30,
      speechPadMs: vadParams.speech_pad_ms || 30,
      samplesOverlap: vadParams.samples_overlap || 0.1
    })

    const jobId = this.addon._activeJobId
    const response = this._createResponse(jobId)
    this._hasActiveResponse = true
    const finalized = response.await().finally(() => {
      this._hasActiveResponse = false
      this.addon._activeJobId = null
      this.addon._setState('listening')
    })
    finalized.catch(() => {})
    response.await = () => finalized

    this._handleStreamingAudio(audioStream).catch((error) => {
      response.failed(error)
      this._deleteJobMapping(jobId)
    })
    return response
  }

  async _handleAudioStream (audioStream) {
    this.logger.debug('Start handling audio stream', { file: this.file })
    for await (const chunk of audioStream) {
      this.logger.debug('Appending audio chunk', { chunkLength: chunk.length })
      await this.addon.append({
        type: 'audio',
        input: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      })
    }
    this.logger.debug('Sending end-of-input signal')
    await this.addon.append({ type: END_OF_INPUT })
  }

  async _handleStreamingAudio (audioStream) {
    this.logger.debug('Start handling streaming audio')
    for await (const chunk of audioStream) {
      this.addon.appendStreamingAudio({
        input: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      })
    }
    this.logger.debug('Ending streaming session')
    this.addon.endStreaming()
  }

  _normalizeAudioStream (audioStream) {
    if (!audioStream) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.INVALID_AUDIO_INPUT,
        adds: 'audioStream is required'
      })
    }

    if (typeof audioStream[Symbol.asyncIterator] === 'function') {
      return audioStream
    }

    if (audioStream instanceof Uint8Array) {
      return [audioStream]
    }

    if (Array.isArray(audioStream)) {
      return audioStream
    }

    if (typeof audioStream[Symbol.iterator] === 'function') {
      return [Uint8Array.from(audioStream)]
    }

    throw new QvacErrorAddonWhisper({
      code: ERR_CODES.INVALID_AUDIO_INPUT,
      adds: 'Unsupported audio input. Expected stream, Uint8Array, or chunk array.'
    })
  }

  /**
   * Reload the model with new configuration parameters.
   * Useful for changing settings like language without destroying the instance.
   * @param {Object} newConfig - New configuration parameters
   * @param {Object} [newConfig.whisperConfig] - Whisper-specific settings (language, duration_ms, etc.)
   * @param {Object} [newConfig.miscConfig] - Miscellaneous configuration
   * @param {string} [newConfig.audio_format] - Audio format (defaults to 's16le')
   */
  async reload (newConfig = {}) {
    return await this._withExclusiveRun(async () => {
      this.logger.debug('Reloading addon with new configuration', newConfig)

      // Merge new config with existing params
      if (newConfig.whisperConfig) {
        this.params = { ...this.params, ...newConfig.whisperConfig }
      }

      const whisperConfig = {
        ...this.params,
        ...newConfig.whisperConfig,
        language: newConfig.whisperConfig?.language || this.params.language || 'en',
        duration_ms: newConfig.whisperConfig?.duration_ms ?? (this.params.max_seconds ? this.params.max_seconds * 1000 : 0),
        temperature: newConfig.whisperConfig?.temperature ?? this.params.temperature ?? 0.0,
        suppress_nst: newConfig.whisperConfig?.suppress_nst ?? this.params.suppress_nst ?? true,
        n_threads: newConfig.whisperConfig?.n_threads ?? this.params.n_threads ?? 0
      }

      // Remove SDK-level params that aren't valid for C++ addon
      delete whisperConfig.audio_format
      delete whisperConfig.contextParams
      delete whisperConfig.miscConfig
      delete whisperConfig.vadModelPath
      delete whisperConfig.vad_params

      // VAD model configuration
      const vadModelPath = this._config.vadModelPath || this._getVadModelFilePath()
      if (vadModelPath) {
        whisperConfig.vad_model_path = vadModelPath
        whisperConfig.vadParams = newConfig.whisperConfig?.vad_params || this.params.vad_params || { threshold: 0.6 }
      }

      const configurationParams = {
        contextParams: {
          model: this._config.path || this._getModelFilePath()
        },
        whisperConfig,
        miscConfig: newConfig.miscConfig || {
          caption_enabled: false
        },
        audio_format: newConfig.audio_format || this.params.audio_format || 's16le'
      }

      _checkParamsExists(configurationParams)
      await this.cancel()
      this._failAndClearActiveResponse('Model was reloaded')
      await this.addon.reload(configurationParams)
      await this.addon.activate()
      this.logger.debug('Addon reloaded and activated successfully')
    })
  }

  async _downloadWeights (reportProgressCallback, opts) {
    const models = [this._modelName]
    if (this._vadModelName) {
      models.push(this._vadModelName)
    }

    this.logger.info('Loading weight files:', models)

    const result = await this.weightsProvider.downloadFiles(
      models,
      this._diskPath,
      {
        closeLoader: opts.closeLoader,
        onDownloadProgress: reportProgressCallback
      }
    )
    this.logger.info('Weight files downloaded successfully', { models })
    return result
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Local file or directory path
   * @param {Object} configurationParams.settings - LLM-specific settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon (configurationParams) {
    this.logger.info(
      'Creating Whisper interface with configuration:',
      configurationParams
    )
    const binding = require('./binding')
    return new WhisperInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.logger.info.bind(this.logger)
    )
  }

  /**
   * Override unload to also call destroyInstance for proper cleanup
   * This ensures the process can exit cleanly by closing the uv_async handle
   */
  async unload () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      this._failAndClearActiveResponse('Model was unloaded')
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.weightsLoaded = false
    })
  }

  async runStreaming (audioStream) {
    if (this.exclusiveRun) {
      return await this._withExclusiveRun(() =>
        this._runInternal(audioStream, { streaming: true })
      )
    }
    return await this._runInternal(audioStream, { streaming: true })
  }

  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  async destroy () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      this._failAndClearActiveResponse('Model was destroyed')
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.weightsLoaded = false
      this.state.destroyed = true
    })
  }

  _failAndClearActiveResponse (reason) {
    for (const [jobId, response] of this._jobToResponse.entries()) {
      response.failed(new Error(reason))
      this._deleteJobMapping(jobId)
    }
    this._hasActiveResponse = false
  }

  validateModelFiles () {
    const modelPath = this._config.path || this._getModelFilePath()
    if (!modelPath || !fs.existsSync(modelPath)) {
      this.logger.error('Model file not found', { path: modelPath })
      throw new Error(
        modelPath
          ? `Model file doesn't exist: ${modelPath}`
          : "Model file doesn't exist"
      )
    }

    if (this._config.whisperConfig && this._config.whisperConfig.vad_model_path) {
      const vadModelPath = this._config.whisperConfig.vad_model_path
      if (!vadModelPath || !fs.existsSync(vadModelPath)) {
        this.logger.error('VAD model file not found', { path: vadModelPath })
        throw new Error(
          vadModelPath
            ? `VAD model file doesn't exist: ${vadModelPath}`
            : "VAD model file doesn't exist"
        )
      }
    }
  }
}

function _checkParamsExists (params) {
  // Use the centralized config validation from configChecker.js
  checkConfig(params)
}

module.exports = TranscriptionWhispercpp
