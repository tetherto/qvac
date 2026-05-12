'use strict'

const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const { createJobHandler } = require('@qvac/infer-base')

const { ParakeetInterface } = require('./parakeet')
const { END_OF_INPUT, ERR_CODES, QvacErrorAddonParakeet } = require('./lib/error')

/**
 * High-level Parakeet speech-to-text client backed by the ggml engine
 * sourced from qvac-parakeet.cpp. Takes a single `.gguf` checkpoint
 * (CTC, TDT, EOU, or Sortformer); the model type is auto-detected
 * from GGUF metadata, so the same class transcribes or diarizes
 * depending on the file you load.
 */
class TranscriptionParakeet {
  /**
   * Creates an instance of TranscriptionParakeet.
   * @constructor
   * @param {Object} opts
   * @param {Object} [opts.files={}] - Map of model file paths
   * @param {string} [opts.files.model] - Absolute path to a single
   *   `.gguf` produced by `qvac-parakeet.cpp/scripts/convert-nemo-to-gguf.py`.
   * @param {Object} [opts.config={}] - Parakeet inference configuration
   * @param {Object} [opts.config.parakeetConfig] - Parakeet-specific configuration
   * @param {number} [opts.config.parakeetConfig.maxThreads=4] - Max CPU threads (0 = engine picks)
   * @param {boolean} [opts.config.parakeetConfig.useGPU=false] - Enable the linked ggml GPU backend
   * @param {boolean} [opts.config.parakeetConfig.captionEnabled=false] - Caption/subtitle mode
   * @param {boolean} [opts.config.parakeetConfig.timestampsEnabled=true] - Include timestamps in output
   * @param {number} [opts.config.parakeetConfig.seed=-1] - Random seed (-1 = random)
   * @param {boolean} [opts.config.parakeetConfig.streaming=false] - Open a long-lived
   *   StreamSession / SortformerStreamSession at load time so speaker IDs stay
   *   stable across appends and EOU `<EOU>` boundaries surface as segments.
   *   Cross-append state (speaker history, EOU rolling window, partial decode
   *   state) survives only within a single `run()` call -- it does NOT persist
   *   across separate `run()` calls on the same instance. For live continuous
   *   capture, drive a single long-running `run()` from a pushable stream, or
   *   use {@link TranscriptionParakeet#runStreaming} which owns one parakeet
   *   streaming session for the entire call regardless of append count.
   * @param {number} [opts.config.parakeetConfig.streamingChunkMs=2000] - Streaming chunk cadence
   * @param {number} [opts.config.parakeetConfig.streamingHistoryMs=30000] - Sortformer rolling history
   * @param {boolean} [opts.config.parakeetConfig.streamingEmitPartials=true] - Emit partial segments
   * @param {boolean} [opts.config.parakeetConfig.streamingEnergyVad=false] - CTC/TDT energy-VAD events
   * @param {number} [opts.config.parakeetConfig.streamingLeftContextMs] - Encoder left
   *   context kept upstream of each chunk (default 10000 -- parakeet-cpp's own).
   *   ASR sessions only; Sortformer ignores it.
   * @param {number} [opts.config.parakeetConfig.streamingRightLookaheadMs] - Future
   *   audio the encoder waits for before emitting each chunk (default 2000 --
   *   parakeet-cpp's own). Adds directly to per-segment latency floor.
   *   ASR sessions only; Sortformer ignores it.
   * @param {Object} [opts.logger=null] - Optional structured logger
   * @param {boolean} [opts.exclusiveRun=true] - Whether to run exclusively
   */
  constructor ({ files = {}, config = {}, logger = null, exclusiveRun = true }) {
    this.logger = new QvacLogger(logger)
    this.exclusiveRun = !!exclusiveRun
    this._runQueueWaiter = Promise.resolve()
    this.state = { configLoaded: false, weightsLoaded: false, destroyed: false }

    this._config = {
      ...config,
      modelPath: files.model
    }

    this.params = config.parakeetConfig || {}
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })

    this.logger.debug('TranscriptionParakeet constructor called', {
      params: this.params,
      config: this._config
    })

    this.validateModelFiles()
  }

  /**
   * Validate that the configured GGUF exists. Logs (does not throw)
   * so callers can pre-stage the file asynchronously between
   * construction and `load()`.
   */
  validateModelFiles () {
    const modelPath = this._config.modelPath
    if (modelPath && !fs.existsSync(modelPath)) {
      this.logger.warn('Model file not found', { path: modelPath })
    }
  }

  /**
   * Build native addon configuration (shared by _load and reload).
   * @returns {Object} configurationParams for createInstance / reload / activate
   * @private
   */
  _buildConfigurationParams () {
    // modelType is intentionally not passed: the binding reads
    // `parakeet.model.type` from the GGUF metadata at load() time and
    // overrides cfg_.modelType so the right dispatch (ASR vs
    // Sortformer) is chosen automatically.
    return {
      modelPath: this._config.modelPath || '',
      maxThreads: this.params.maxThreads ?? 4,
      useGPU: this.params.useGPU === true,
      sampleRate: this.params.sampleRate || 16000,
      channels: this.params.channels || 1,
      captionEnabled: this.params.captionEnabled === true,
      timestampsEnabled: this.params.timestampsEnabled !== false,
      seed: this.params.seed ?? -1,
      streaming: this.params.streaming === true,
      streamingChunkMs: this.params.streamingChunkMs ?? 2000,
      streamingHistoryMs: this.params.streamingHistoryMs ?? 30000,
      streamingEmitPartials: this.params.streamingEmitPartials !== false,
      streamingEnergyVad: this.params.streamingEnergyVad === true,
      streamingLeftContextMs: this.params.streamingLeftContextMs ?? -1,
      streamingRightLookaheadMs: this.params.streamingRightLookaheadMs ?? -1
    }
  }

  getState () {
    return this.state
  }

  async load () {
    if (this.state.destroyed) {
      throw new QvacErrorAddonParakeet(ERR_CODES.INSTANCE_DESTROYED)
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
    this.state.configLoaded = true
    this.state.weightsLoaded = true
  }

  async run (input) {
    if (this.exclusiveRun) {
      return await this._withExclusiveRun(() => this._runInternal(input))
    }
    return await this._runInternal(input)
  }

  /**
   * Duplex streaming entry point. Opens a long-lived
   * `parakeet::StreamSession` (or `SortformerStreamSession`) on the C++
   * side and feeds each chunk from `audioStream` directly into it as
   * the chunks arrive -- without batching the whole utterance in JS
   * memory the way `run()` does. Per-chunk segments surface through
   * `response.onUpdate(...)` as soon as the engine emits them. The
   * session is closed (and the response resolves with a synthetic
   * `JobEnded`) when the audio stream completes.
   *
   * @param {AsyncIterable<Buffer|Float32Array>} audioStream - 16 kHz mono
   *   PCM stream. s16le `Buffer` chunks are converted to Float32 in
   *   [-1, 1] internally; Float32Array chunks are passed through.
   * @param {Object} [streamingConfig] - per-call overrides forwarded to
   *   the native processor. Any field omitted falls back to the
   *   `parakeetConfig.streaming*` value used at load time.
   * @param {number} [streamingConfig.chunkMs] - encoder cadence in ms
   * @param {number} [streamingConfig.historyMs] - Sortformer rolling
   *   history window in ms
   * @param {boolean} [streamingConfig.emitPartials] - emit partial
   *   segments on chunk boundaries (default true)
   * @param {boolean} [streamingConfig.emitEnergyVad] - surface
   *   energy-VAD events for CTC/TDT
   * @returns {Promise<QvacResponse>} - response object exposing
   *   `onUpdate(seg => ...).await()`
   */
  async runStreaming (audioStream, streamingConfig = {}) {
    if (this.exclusiveRun) {
      return await this._withExclusiveRun(
        () => this._runStreamingInternal(audioStream, streamingConfig)
      )
    }
    return await this._runStreamingInternal(audioStream, streamingConfig)
  }

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
   * Load model and activate addon.
   */
  async _load () {
    const configurationParams = this._buildConfigurationParams()

    this.logger.info('Creating Parakeet addon with configuration:', configurationParams)
    this.addon = this._createAddon(configurationParams)

    await this.addon.activate()
    this.logger.debug('Addon activated')
  }

  /**
   * Run transcription on an audio stream
   * @param {AsyncIterable<Buffer>} audioStream - Stream of audio data (16kHz mono, Float32 or s16le)
   * @returns {Promise<QvacResponse>} - Response object for tracking the transcription job
   */
  async _runInternal (audioStream) {
    const response = this._job.start()

    let normalized
    try {
      normalized = this._normalizeAudioStream(audioStream)
    } catch (error) {
      this._job.fail(error)
      throw error
    }

    this._handleAudioStream(normalized).catch((error) => {
      this._job.fail(error)
    })

    return response
  }

  async _runStreamingInternal (audioStream, streamingConfig) {
    const normalized = this._normalizeAudioStream(audioStream)
    const response = this._job.start()

    try {
      await this.addon.startStreaming(streamingConfig || {})
    } catch (error) {
      this._job.fail(error)
      throw error
    }

    this._pumpStreamingAudio(normalized).catch((error) => {
      this.addon.endStreaming().catch(() => {})
      this._job.fail(error)
    })

    return response
  }

  async _pumpStreamingAudio (audioStream) {
    this.logger.debug('Start pumping audio into duplex streaming session')
    for await (const chunk of audioStream) {
      let audioData
      if (chunk instanceof Float32Array) {
        audioData = chunk
      } else {
        const int16Data = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
        audioData = new Float32Array(int16Data.length)
        for (let i = 0; i < int16Data.length; i++) {
          audioData[i] = int16Data[i] / 32768.0
        }
      }
      if (audioData.length === 0) continue
      await this.addon.appendStreamingAudio(audioData)
    }
    this.logger.debug('Audio stream completed; closing duplex streaming session')
    await this.addon.endStreaming()
  }

  /**
   * Handle incoming audio stream
   * @param {AsyncIterable<Buffer>} audioStream - Audio data stream
   * @private
   */
  async _handleAudioStream (audioStream) {
    this.logger.debug('Start handling audio stream')
    for await (const chunk of audioStream) {
      this.logger.debug('Appending audio chunk', { chunkLength: chunk.length })

      // Convert chunk to Float32Array if needed
      let audioData
      if (chunk instanceof Float32Array) {
        audioData = chunk
      } else {
        // Assume s16le format, convert to float32
        const int16Data = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
        audioData = new Float32Array(int16Data.length)
        for (let i = 0; i < int16Data.length; i++) {
          audioData[i] = int16Data[i] / 32768.0
        }
      }

      await this.addon.append({
        type: 'audio',
        data: audioData.buffer
      })
    }
    this.logger.debug('Sending end-of-input signal')
    await this.addon.append({ type: END_OF_INPUT })
  }

  _normalizeAudioStream (audioStream) {
    if (!audioStream) {
      throw new Error('audioStream is required')
    }

    if (typeof audioStream[Symbol.asyncIterator] === 'function') {
      return audioStream
    }

    if (audioStream instanceof Uint8Array || audioStream instanceof Float32Array) {
      return [audioStream]
    }

    if (Array.isArray(audioStream)) {
      return audioStream
    }

    if (typeof audioStream[Symbol.iterator] === 'function') {
      return [Uint8Array.from(audioStream)]
    }

    throw new Error('Unsupported audio input. Expected stream, TypedArray, or chunk array.')
  }

  _outputCallback (addon, event, jobId, data, error) {
    if (event === 'Error') {
      this._job.fail(error instanceof Error ? error : new Error(String(error)))
    } else if (event === 'Output') {
      this._job.output(data)
    } else if (event === 'JobEnded') {
      this._job.end(data)
    }
  }

  /**
   * Reload the model with new configuration parameters.
   * Useful for changing settings without destroying the instance.
   * @param {Object} [newConfig={}] - New configuration parameters
   * @param {Object} [newConfig.parakeetConfig] - Parakeet-specific settings
   */
  async reload (newConfig = {}) {
    return await this._withExclusiveRun(async () => {
      this.logger.debug('Reloading addon with new configuration', newConfig)

      if (newConfig.parakeetConfig) {
        this.params = { ...this.params, ...newConfig.parakeetConfig }
      }

      const configurationParams = this._buildConfigurationParams()

      await this.cancel()
      this._job.fail(new Error('Model was reloaded'))
      await this.addon.reload(configurationParams)
      await this.addon.activate()

      this.logger.debug('Addon reloaded and activated successfully')
    })
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @returns {ParakeetInterface} The instantiated addon interface
   * @private
   */
  _createAddon (configurationParams) {
    this.logger.info('Creating Parakeet interface with configuration:', configurationParams)
    const binding = require('./binding')
    return new ParakeetInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.logger.info.bind(this.logger)
    )
  }

  /**
   * Override unload to call destroyInstance for proper cleanup.
   */
  async unload () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      this._job.fail(new Error('Model was unloaded'))
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.weightsLoaded = false
    })
  }

  async cancel (jobId) {
    if (this.addon?.cancel) {
      await this.addon.cancel(jobId)
    }
    if (this._job.active) {
      this._job.fail(new QvacErrorAddonParakeet(ERR_CODES.JOB_CANCELLED))
    }
  }

  async status () {
    return this.addon?.status()
  }

  async pause () {
    await this.addon?.pause()
  }

  async unpause () {
    await this.addon?.activate()
  }

  async destroy () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      this._job.fail(new Error('Model was destroyed'))
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.destroyed = true
    })
  }
}

module.exports = TranscriptionParakeet
