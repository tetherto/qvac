'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')

const { WhisperInterface } = require('./whisper')
const { checkConfig } = require('./configChecker')
const { QvacErrorAddonWhisper, ERR_CODES } = require('./lib/error')

// Default prebuilds folder for dynamically-loaded ggml backend `.so`
// files. Consumed by the native addon on Android (no-op elsewhere).
const PREBUILDS_DIR = path.join(__dirname, 'prebuilds')

const END_OF_INPUT = 'end of job'

const MS_PER_SECOND = 1000
const DEFAULT_AUDIO_FORMAT = 's16le'

// Default VAD threshold for the batch/reload path when the caller omits
// `vad_params.threshold`.
const DEFAULT_VAD_THRESHOLD = 0.6

// Whisper decoder defaults applied when the caller leaves a field unset.
const DEFAULT_WHISPER_CONFIG = Object.freeze({
  language: 'en',
  durationMs: 0,
  temperature: 0.0,
  suppressNst: true,
  nThreads: 0
})

// SDK-level keys that configure the JS wrapper but are not valid
// `whisper_full_params`, so they must be stripped before the config reaches
// (and is validated by) the native addon.
const NON_ADDON_WHISPER_KEYS = [
  'audio_format',
  'contextParams',
  'miscConfig',
  'vadModelPath',
  'vad_params',
  'backendsDir',
  'max_seconds'
]

// Default VAD knobs for `runStreaming`. Mirrors the native
// StreamingProcessor::Config defaults (StreamingProcessor.hpp); the streaming
// path intentionally uses a lower detection threshold than the batch default.
const DEFAULT_STREAMING_VAD_CONFIG = Object.freeze({
  vadThreshold: 0.5,
  minSilenceDurationMs: 500,
  minSpeechDurationMs: 250,
  maxSpeechDurationS: 30,
  speechPadMs: 30,
  samplesOverlap: 0.1,
  endOfTurnSilenceMs: 0
})

/**
 * GGML client implementation for the Whisper transcription model
 */
class TranscriptionWhispercpp {
  /**
   * Creates an instance of WhisperClient.
   * @constructor
   * @param {Object} args - arguments for inference setup (`files`, `logger`, `exclusiveRun`, `opts`, …)
   * @param {Object} args.files - local model file paths
   * @param {string} args.files.model - path to the Whisper GGML model file
   * @param {string} [args.files.vadModel] - optional path to the Silero VAD model
   * @param {Object} config - environment-specific inference setup configuration
   */
  constructor({ files, logger = null, exclusiveRun = true, ...args }, config) {
    if (!files || typeof files.model !== 'string' || files.model.length === 0) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.MODEL_REQUIRED,
        adds: 'files.model is required'
      })
    }

    const { opts = {}, ...passThrough } = { logger, exclusiveRun, ...args }
    this.opts = opts
    this.logger = new QvacLogger(passThrough.logger)
    this.exclusiveRun = !!passThrough.exclusiveRun
    this._withExclusiveRun = exclusiveRunQueue()
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }

    const vadModel =
      typeof files.vadModel === 'string' && files.vadModel.length > 0 ? files.vadModel : null

    this._files = { model: files.model, vadModel }
    this._config = config

    this.params = config.whisperConfig
    /** Serializes inference runs; separate from `_withExclusiveRun` queue (reload / destroy / unload). */
    this._inferenceQueueWaiter = Promise.resolve()
    /** Batch append returns this id before `_activeJobId` is set; needed for `cancel(jobId)` during buffering. */
    this._pendingWhisperJobId = null
    this._job = createJobHandler({
      cancel: () => {
        const jobId = this._pendingWhisperJobId ?? this.addon?._activeJobId
        return this.addon?.cancel?.(jobId)
      }
    })

    this.logger.debug('TranscriptionWhispercpp constructor called', {
      params: this.params,
      config: this._config,
      modelPath: this._files.model,
      vadModelPath: this._files.vadModel
    })

    this.validateModelFiles()
  }

  getState() {
    return this.state
  }

  async load(...loadArgs) {
    if (this.state.destroyed) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: 'instance was destroyed'
      })
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }

    await this._load(...loadArgs)
    this.state.configLoaded = true
    this.state.weightsLoaded = true
  }

  async pause() {
    if (!this.addon?.pause) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_PAUSE,
        adds: 'pause not supported'
      })
    }
    await this.addon.pause()
  }

  async unpause() {
    if (!this.addon?.activate) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: 'activate not supported'
      })
    }
    await this.addon.activate()
  }

  async stop() {
    if (!this.addon?.stop) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_STOP,
        adds: 'stop not supported'
      })
    }
    await this.addon.stop()
  }

  async status() {
    if (!this.addon?.status) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_GET_STATUS,
        adds: 'status not supported'
      })
    }
    return await this.addon.status()
  }

  _resolveVadModelPath() {
    if (this._config.vadModelPath) {
      return this._config.vadModelPath
    }
    if (this._files.vadModel) {
      return this._files.vadModel
    }
    if (this.params?.vad_model_path) {
      return this.params.vad_model_path
    }
    return null
  }

  /**
   * Load model and activate addon. Model files must already exist at `files.model` / optional `files.vadModel`.
   * @param {boolean} [_closeLoader=false] - Unused; kept for `load(...args)` forwarding compatibility.
   * @param {Function} [_reportProgressCallback] - Unused; kept for `load(...args)` forwarding compatibility.
   */
  async _load(_closeLoader = false, _reportProgressCallback) {
    this.logger.debug('TranscriptionWhispercpp _load (local model files)')

    const configurationParams = this._buildConfigurationParams()

    _checkParamsExists(configurationParams)
    this.addon = this._createAddon(configurationParams)

    await this.addon.activate()
    this.logger.debug('Addon activated')
  }

  _getModelFilePath() {
    return this._files.model
  }

  /**
   * Build the wire-format config consumed by the native addon from the
   * instance params/config, applying whisper decoder defaults and stripping
   * SDK-only keys. Shared by both `_load` and `reload` so the two paths cannot
   * drift.
   * @param {Object} [overrides] - reload-time overrides (`whisperConfig`, `miscConfig`, `audio_format`)
   */
  _buildConfigurationParams(overrides = {}) {
    return {
      contextParams: {
        model: this._config.path || this._getModelFilePath(),
        ...(this._config.contextParams || {})
      },
      whisperConfig: this._buildWhisperConfig(overrides.whisperConfig || {}),
      miscConfig: overrides.miscConfig || {
        caption_enabled: false,
        ...(this._config.miscConfig || {})
      },
      audio_format:
        overrides.audio_format ||
        this._config.audio_format ||
        this.params.audio_format ||
        DEFAULT_AUDIO_FORMAT,
      backendsDir: this.params.backendsDir || PREBUILDS_DIR
    }
  }

  _buildWhisperConfig(overrideWhisperConfig) {
    const whisperConfig = {
      ...this.params,
      language: this.params.language || DEFAULT_WHISPER_CONFIG.language,
      duration_ms: this._resolveDurationMs(overrideWhisperConfig),
      temperature: this.params.temperature ?? DEFAULT_WHISPER_CONFIG.temperature,
      suppress_nst: this.params.suppress_nst ?? DEFAULT_WHISPER_CONFIG.suppressNst,
      n_threads: this.params.n_threads || DEFAULT_WHISPER_CONFIG.nThreads
    }
    this._stripNonAddonKeys(whisperConfig)
    this._applyVadConfig(whisperConfig, overrideWhisperConfig)
    return whisperConfig
  }

  _resolveDurationMs(overrideWhisperConfig) {
    const fromMaxSeconds = this.params.max_seconds
      ? this.params.max_seconds * MS_PER_SECOND
      : DEFAULT_WHISPER_CONFIG.durationMs
    return overrideWhisperConfig.duration_ms ?? fromMaxSeconds
  }

  _stripNonAddonKeys(whisperConfig) {
    for (const key of NON_ADDON_WHISPER_KEYS) {
      delete whisperConfig[key]
    }
  }

  _applyVadConfig(whisperConfig, overrideWhisperConfig) {
    const vadModelPath = this._resolveVadModelPath()
    if (!vadModelPath) {
      return
    }
    whisperConfig.vad_model_path = vadModelPath
    whisperConfig.vadParams = overrideWhisperConfig.vad_params ||
      this.params.vad_params || { threshold: DEFAULT_VAD_THRESHOLD }
  }

  /**
   * Serialize inference until the returned response settles (replaces `_hasActiveResponse`).
   * Uses a dedicated waiter so `destroy` / `reload` (`_runQueueWaiter`) can still preempt.
   */
  async _enqueueExclusiveRunResponse(runFn) {
    const prev = this._inferenceQueueWaiter || Promise.resolve()
    let releaseSlot
    this._inferenceQueueWaiter = new Promise((resolve) => {
      releaseSlot = resolve
    })
    await prev
    let response
    try {
      response = await runFn()
    } catch (err) {
      releaseSlot()
      throw err
    }
    response
      .await()
      .finally(() => {
        releaseSlot()
      })
      .catch(() => {})
    return response
  }

  async run(input) {
    if (this.exclusiveRun) {
      return await this._enqueueExclusiveRunResponse(() => this._runInternal(input))
    }
    return await this._runInternal(input)
  }

  async runStreaming(audioStream, opts = {}) {
    if (this.exclusiveRun) {
      return await this._enqueueExclusiveRunResponse(() =>
        this._runInternal(audioStream, { ...opts, streaming: true })
      )
    }
    return await this._runInternal(audioStream, { ...opts, streaming: true })
  }

  async _runInternal(audioStream, opts = {}) {
    const normalizedAudioStream = this._normalizeAudioStream(audioStream)

    if (opts.streaming) {
      return this._runStreaming(normalizedAudioStream, opts)
    }

    return this._runBatchTranscription(normalizedAudioStream)
  }

  /** Batch runJob path: `_job` / response setup; audio via {@link #_handleAudioStream}. */
  async _runBatchTranscription(normalizedAudioStream) {
    this._pendingWhisperJobId = await this.addon.append({
      type: 'audio',
      input: new Uint8Array()
    })

    const response = this._job.start()
    const finalized = response.await()
    finalized.catch(() => {})
    response.await = () => finalized

    this._handleAudioStream(normalizedAudioStream).catch((error) => {
      this._pendingWhisperJobId = null
      this._job.fail(error)
    })
    return response
  }

  async _runStreaming(audioStream, streamingOpts = {}) {
    const vadModelPath = this._resolveVadModelPath()
    if (!vadModelPath) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.VAD_MODEL_REQUIRED
      })
    }

    const streamingConfig = this._buildStreamingConfig(vadModelPath, streamingOpts)
    this.addon.startStreaming(streamingConfig)

    this._pendingWhisperJobId = null
    const response = this._job.start()
    const finalized = response.await().finally(() => {
      this.addon.finishStreaming()
    })
    finalized.catch(() => {})
    response.await = () => finalized

    this._handleStreamingAudio(audioStream).catch((error) => {
      this._pendingWhisperJobId = null
      this._job.fail(error)
    })
    return response
  }

  _buildStreamingConfig(vadModelPath, streamingOpts) {
    const vadParams = this.params?.vad_params || {}
    const defaults = DEFAULT_STREAMING_VAD_CONFIG
    const streamingConfig = {
      vadModelPath,
      vadThreshold: vadParams.threshold || defaults.vadThreshold,
      minSilenceDurationMs: vadParams.min_silence_duration_ms || defaults.minSilenceDurationMs,
      minSpeechDurationMs: vadParams.min_speech_duration_ms || defaults.minSpeechDurationMs,
      maxSpeechDurationS: vadParams.max_speech_duration_s || defaults.maxSpeechDurationS,
      speechPadMs: vadParams.speech_pad_ms || defaults.speechPadMs,
      samplesOverlap: vadParams.samples_overlap || defaults.samplesOverlap,
      emitVadEvents: Boolean(streamingOpts.emitVadEvents || streamingOpts.conversationMode),
      endOfTurnSilenceMs: streamingOpts.endOfTurnSilenceMs || defaults.endOfTurnSilenceMs
    }
    if (streamingOpts.vadRunIntervalMs !== undefined) {
      streamingConfig.vadRunIntervalMs = streamingOpts.vadRunIntervalMs
    }
    return streamingConfig
  }

  /** Append-only path to the native addon; job lifecycle lives in callers / `_outputCallback`. */
  async _handleAudioStream(audioStream) {
    this.logger.debug('Start handling audio stream', {
      modelPath: this._getModelFilePath()
    })
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

  async _handleStreamingAudio(audioStream) {
    this.logger.debug('Start handling streaming audio')
    for await (const chunk of audioStream) {
      this.addon.appendStreamingAudio({
        input: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      })
    }
    this.logger.debug('Ending streaming session')
    this.addon.endStreaming()
  }

  _normalizeAudioStream(audioStream) {
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
  async reload(newConfig = {}) {
    return await this._withExclusiveRun(async () => {
      this.logger.debug('Reloading addon with new configuration', newConfig)

      // Merge new config with existing params
      if (newConfig.whisperConfig) {
        this.params = { ...this.params, ...newConfig.whisperConfig }
      }

      const configurationParams = this._buildConfigurationParams({
        whisperConfig: newConfig.whisperConfig,
        miscConfig: newConfig.miscConfig,
        audio_format: newConfig.audio_format
      })

      _checkParamsExists(configurationParams)
      this._pendingWhisperJobId = null
      if (this._job.active) {
        this._job.fail(new Error('Model was reloaded'))
      }
      await this.cancel()
      await this.addon.reload(configurationParams)
      await this.addon.activate()
      this.logger.debug('Addon reloaded and activated successfully')
    })
  }

  /**
   * Instantiate the native Whisper addon.
   * @param {Object} configurationParams - wire-format config consumed by `JSAdapter::loadFromJSObject`
   * @param {Object} configurationParams.contextParams - `whisper_context_params` (must contain `model`)
   * @param {Object} configurationParams.whisperConfig - `whisper_full_params` decoder/VAD knobs
   * @param {Object} [configurationParams.miscConfig] - addon-side knobs (e.g. `caption_enabled`)
   * @param {string} [configurationParams.audio_format] - PCM input format (`s16le` by default)
   * @param {string} [configurationParams.backendsDir] - root of the per-arch ggml backend `.so` modules (Android only)
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon(configurationParams) {
    this.logger.info('Creating Whisper interface with configuration:', configurationParams)
    const binding = require('./binding')
    return new WhisperInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.logger.info.bind(this.logger)
    )
  }

  _outputCallback(addon, event, jobId, data, error) {
    if (event === 'Error') {
      this.logger.error(`Job failed with error: ${error}`)
      this._pendingWhisperJobId = null
      this._job.fail(error)
      return
    }
    if (event === 'Output') {
      try {
        this.logger.debug(`Job produced output: ${dataAsStringWhisper(data)}`)
      } catch (err) {
        this.logger.error(`Failed to serialize output for logging: ${err.message}`)
        this.logger.debug('Job produced output: [non-serializable data]')
      }
      this._job.output(data)
      return
    }
    if (event === 'VadState' || event === 'EndOfTurn') {
      this.logger.debug(`Job produced conversation event: ${dataAsStringWhisper(data)}`)
      this._job.output(data)
      return
    }
    if (event === 'JobEnded') {
      this.logger.info(`Job ${jobId} completed. Stats: ${JSON.stringify(data)}`)
      this._pendingWhisperJobId = null
      if (this.opts?.stats) {
        this._job.end(data)
      } else {
        this._job.end()
      }
      return
    }
    this.logger.debug(`Received event for job ${jobId}: ${event}`)
  }

  /**
   * Override unload to also call destroyInstance for proper cleanup
   * This ensures the process can exit cleanly by closing the uv_async handle
   */
  async unload() {
    return await this._withExclusiveRun(async () => {
      this._pendingWhisperJobId = null
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      await this.cancel()
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.weightsLoaded = false
    })
  }

  async cancel() {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
    this._pendingWhisperJobId = null
    if (this._job.active) {
      this._job.fail(new Error('Job cancelled'))
    }
  }

  async destroy() {
    return await this._withExclusiveRun(async () => {
      this._pendingWhisperJobId = null
      if (this._job.active) {
        this._job.fail(new Error('Model was destroyed'))
      }
      await this.cancel()
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.weightsLoaded = false
      this.state.destroyed = true
    })
  }

  validateModelFiles() {
    const modelPath = this._config.path || this._getModelFilePath()
    if (!modelPath || !fs.existsSync(modelPath)) {
      this.logger.error('Model file not found', { path: modelPath })
      throw new Error(
        modelPath ? `Model file doesn't exist: ${modelPath}` : "Model file doesn't exist"
      )
    }

    const vadModelPath = this._resolveVadModelPath()
    if (vadModelPath && !fs.existsSync(vadModelPath)) {
      this.logger.error('VAD model file not found', { path: vadModelPath })
      throw new QvacErrorAddonWhisper({ code: ERR_CODES.VAD_MODEL_NOT_FOUND, adds: vadModelPath })
    }
  }
}

function dataAsStringWhisper(data) {
  if (!data) return ''
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return data.toString()
}

function _checkParamsExists(params) {
  // Use the centralized config validation from configChecker.js
  checkConfig(params)
}

module.exports = TranscriptionWhispercpp
