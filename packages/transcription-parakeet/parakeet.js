'use strict'

// Try to load QVAC error module, fallback to simple Error class
let QvacErrorAddonParakeet, ERR_CODES, END_OF_INPUT
try {
  const errorModule = require('./lib/error')
  QvacErrorAddonParakeet = errorModule.QvacErrorAddonParakeet
  ERR_CODES = errorModule.ERR_CODES
  END_OF_INPUT = errorModule.END_OF_INPUT
} catch (e) {
  class SimpleParakeetError extends Error {
    constructor (code, message) {
      super(message)
      this.code = code
      this.name = 'QvacErrorAddonParakeet'
    }
  }
  QvacErrorAddonParakeet = SimpleParakeetError
  ERR_CODES = {
    FAILED_TO_LOAD_WEIGHTS: 7001,
    FAILED_TO_CANCEL: 7002,
    FAILED_TO_APPEND: 7003,
    FAILED_TO_GET_STATUS: 7004,
    FAILED_TO_DESTROY: 7005,
    FAILED_TO_ACTIVATE: 7006,
    FAILED_TO_RESET: 7007,
    FAILED_TO_PAUSE: 7008,
    MODEL_NOT_FOUND: 7009,
    INVALID_AUDIO_FORMAT: 7010,
    PREPROCESSOR_NOT_FOUND: 7011,
    VOCAB_NOT_FOUND: 7012,
    ENCODER_NOT_FOUND: 7013,
    DECODER_NOT_FOUND: 7014,
    INVALID_CONFIG: 7015,
    BUFFER_LIMIT_EXCEEDED: 7016
  }
  END_OF_INPUT = 'end of job'
}

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  PAUSED: 'paused',
  STOPPED: 'stopped'
})

function nextSafeId (current) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
}

// 500 MB — ~2.7 hours of 16 kHz f32le mono audio
const MAX_BUFFERED_BYTES = 500 * 1024 * 1024

function createParakeetError (code, message, cause = undefined) {
  // @qvac/error expects an options object, while the local fallback class
  // accepts positional args. Support both call shapes.
  try {
    return new QvacErrorAddonParakeet({ code, adds: message, cause })
  } catch {
    return new QvacErrorAddonParakeet(code, message)
  }
}

/**
 * An interface between Bare addon in C++ and JS runtime.
 * Provides low-level access to the Parakeet speech-to-text model.
 */
class ParakeetInterface {
  /**
   * @param {Object} binding - the native binding object
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {string} configurationParams.modelPath - path to the model directory
   * @param {string} configurationParams.modelType - model type: 'tdt', 'ctc', 'eou', or 'sortformer'
   * @param {number} [configurationParams.maxThreads=4] - max CPU threads for inference
   * @param {boolean} [configurationParams.useGPU=false] - enable GPU acceleration
   * @param {number} [configurationParams.sampleRate=16000] - audio sample rate
   * @param {number} [configurationParams.channels=1] - audio channels (must be 1 for mono)
   * @param {boolean} [configurationParams.captionEnabled=false] - enable caption/subtitle mode
   * @param {boolean} [configurationParams.timestampsEnabled=true] - include timestamps in output
   * @param {number} [configurationParams.seed=-1] - random seed (-1 for random)
   * @param {Function} outputCallback - callback for transcription output events
   * @param {Function} [stateCallback] - callback for state transitions
   */
  constructor (binding, configurationParams, outputCallback, stateCallback = null) {
    this._binding = binding
    this._config = configurationParams
    this._outputCallback = outputCallback
    this._stateCallback = stateCallback
    this._handle = null
    this._state = state.LOADING
    this._nextJobId = 1
    this._activeJobId = null
    this._onCancelComplete = null
    this._bufferedAudio = []
    this._bufferedBytes = 0

    this._createNativeInstance(this._config)
  }

  _setState (newState) {
    this._state = newState
    if (this._stateCallback) {
      this._stateCallback(this, newState)
    }
  }

  _createNativeInstance (configurationParams) {
    this._config = configurationParams
    // Wrapper job ids are owned in JS, so recreating the native instance only
    // clears native state and buffered audio.
    this._activeJobId = null
    this._onCancelComplete = null
    this._bufferedAudio = []
    this._bufferedBytes = 0
    this._handle = this._binding.createInstance(
      this,
      this._config,
      this._addonOutputCallback.bind(this),
      this._stateCallback
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    const isError = typeof error === 'string' && error.length > 0
    const isStats = data && typeof data === 'object' && (
      'totalTime' in data ||
      'audioDurationMs' in data ||
      'totalSamples' in data
    )
    const isTranscriptOutput = (
      Array.isArray(data) ||
      (data && typeof data === 'object' && typeof data.text === 'string')
    )

    let mappedEvent = event
    if (event === 'Error' || isError || String(event).includes('Error')) {
      mappedEvent = 'Error'
    } else if (event === 'JobEnded' || isStats || String(event).includes('RuntimeStats')) {
      mappedEvent = 'JobEnded'
    } else if (event === 'Output' || isTranscriptOutput || String(event).includes('Output')) {
      mappedEvent = 'Output'
    }

    const isTerminal = mappedEvent === 'Error' || mappedEvent === 'JobEnded'

    const jobId = this._activeJobId
    if (jobId === null) {
      if (isTerminal && this._onCancelComplete) {
        const resolve = this._onCancelComplete
        this._onCancelComplete = null
        resolve()
      }
      return
    }

    if (isTerminal && this._onCancelComplete) {
      const resolve = this._onCancelComplete
      this._onCancelComplete = null
      resolve()
      return
    }

    if (mappedEvent === 'Output') {
      this._setState(state.PROCESSING)
    }

    if (this._outputCallback) {
      this._outputCallback(addon, mappedEvent, jobId, data, isError ? error : null)
    }

    if (mappedEvent === 'Error' || mappedEvent === 'JobEnded') {
      this._activeJobId = null
      this._setState(state.LISTENING)
    }
  }

  _emitSyntheticError (jobId, error) {
    if (!this._outputCallback) {
      return
    }
    this._outputCallback(this, 'Error', jobId, undefined, error)
  }

  /**
   * Load model weights
   * @param {Object} weightsData - weight data chunk
   * @param {string} weightsData.filename - name of the weight file
   * @param {Uint8Array} weightsData.chunk - weight data chunk
   * @param {boolean} weightsData.completed - whether this is the last chunk
   * @param {number} [weightsData.progress] - loading progress percentage
   * @param {number} [weightsData.size] - total file size in bytes
   * @returns {Promise<boolean>}
   */
  async loadWeights (weightsData) {
    try {
      return this._binding.loadWeights(this._handle, weightsData)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_LOAD_WEIGHTS, error.message, error)
    }
  }

  /**
   * Activate the model for inference
   * @returns {Promise<void>}
   */
  async activate () {
    try {
      this._binding.activate(this._handle)
      this._setState(state.LISTENING)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_ACTIVATE, error.message, error)
    }
  }

  /**
   * Append audio data or end-of-job signal
   * @param {Object} data - data to append
   * @param {string} data.type - 'audio' or 'end of job'
   * @param {ArrayBuffer} [data.data] - audio data buffer (Float32, 16kHz mono)
   * @returns {Promise<number>} - job ID
   */
  async append (data) {
    try {
      if (data?.type === END_OF_INPUT) {
        const currentJobId = this._nextJobId
        const input = this._concatBufferedAudio()
        const previousState = this._state
        let accepted = false
        try {
          accepted = this._binding.runJob(this._handle, {
            type: 'audio',
            input
          })
        } catch (error) {
          this._setState(previousState)
          throw error
        }
        if (!accepted) {
          this._setState(previousState)
          throw new Error('Cannot set new job: a job is already set or being processed')
        }

        this._activeJobId = currentJobId
        this._nextJobId = nextSafeId(this._nextJobId)
        this._bufferedAudio = []
        this._bufferedBytes = 0
        this._setState(state.PROCESSING)
        return currentJobId
      }

      if (data?.type === 'audio') {
        const normalized = this._normalizeAudioInput(data.data)
        if (this._bufferedBytes + normalized.byteLength > MAX_BUFFERED_BYTES) {
          throw createParakeetError(ERR_CODES.BUFFER_LIMIT_EXCEEDED, MAX_BUFFERED_BYTES + ' bytes')
        }
        this._bufferedAudio.push(normalized)
        this._bufferedBytes += normalized.byteLength
        return this._nextJobId
      }

      throw new Error(`Unknown append input type: ${data?.type}`)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_APPEND, error.message, error)
    }
  }

  /**
   * Get current model status
   * @returns {Promise<string>} - 'loading', 'listening', 'processing', 'idle', 'paused', 'stopped'
   */
  async status () {
    try {
      return this._state
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_GET_STATUS, error.message, error)
    }
  }

  /**
   * Pause processing
   * @returns {Promise<void>}
   */
  async pause () {
    try {
      this._setState(state.PAUSED)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_PAUSE, error.message, error)
    }
  }

  /**
   * Stop processing and discard current job
   * @returns {Promise<void>}
   */
  async stop () {
    try {
      this._bufferedAudio = []
      this._bufferedBytes = 0
      if (this._activeJobId !== null) {
        const cancelComplete = new Promise(resolve => {
          this._onCancelComplete = resolve
        })
        this._activeJobId = null
        await this._binding.cancel(this._handle)
        await cancelComplete
      }
      this._setState(state.STOPPED)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_RESET, error.message, error)
    }
  }

  /**
   * Cancel a specific job
   * @param {number} jobId - job ID to cancel
   * @returns {Promise<void>}
   */
  async cancel (jobId) {
    try {
      const pendingJobId = this._bufferedAudio.length > 0 ? this._nextJobId : null
      const targetJobId = jobId ?? this._activeJobId ?? pendingJobId

      if (targetJobId === null) {
        this._bufferedAudio = []
        this._bufferedBytes = 0
        this._setState(state.LISTENING)
        return
      }

      if (this._activeJobId === targetJobId) {
        const cancelComplete = new Promise(resolve => {
          this._onCancelComplete = resolve
        })
        await this._binding.cancel(this._handle)
        await cancelComplete
        this._bufferedAudio = []
        this._bufferedBytes = 0
        this._activeJobId = null
        this._setState(state.LISTENING)
        return
      }

      if (this._activeJobId === null && pendingJobId === targetJobId) {
        this._bufferedAudio = []
        this._bufferedBytes = 0
        this._setState(state.LISTENING)
        this._emitSyntheticError(targetJobId, 'Job cancelled')
      }
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_CANCEL, error.message, error)
    }
  }

  /**
   * Reload model configuration
   * @param {Object} configurationParams - new configuration
   * @returns {Promise<void>}
   */
  async reload (configurationParams) {
    try {
      await this.cancel()
      await this.destroyInstance()
      this._createNativeInstance(configurationParams)
      this._setState(state.LOADING)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_RESET, error.message, error)
    }
  }

  /**
   * Unload model weights from memory
   * @returns {Promise<void>}
   */
  async unloadWeights () {
    throw createParakeetError(
      ERR_CODES.FAILED_TO_RESET,
      'unloadWeights is not supported by this package. Use unload() or destroyInstance().'
    )
  }

  async load (configurationParams) {
    try {
      await this.destroyInstance()
      this._createNativeInstance(configurationParams)
      this._setState(state.LOADING)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_RESET, error.message, error)
    }
  }

  async unload () {
    await this.destroyInstance()
  }

  /**
   * Destroy the addon instance and free resources
   * @returns {Promise<void>}
   */
  async destroyInstance () {
    try {
      if (this._handle === null) {
        return
      }
      if (this._activeJobId !== null) {
        try {
          await this._binding.cancel(this._handle)
        } catch {}
      }
      this._binding.destroyInstance(this._handle)
      this._handle = null
      this._activeJobId = null
      this._bufferedAudio = []
      this._bufferedBytes = 0
      this._setState(state.IDLE)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_DESTROY, error.message, error)
    }
  }

  async runJob (data) {
    const currentJobId = this._nextJobId
    const previousJobId = this._activeJobId
    const previousState = this._state
    try {
      const accepted = this._binding.runJob(this._handle, data)
      if (!accepted) {
        this._activeJobId = previousJobId
        this._setState(previousState)
        return false
      }
      this._activeJobId = currentJobId
      this._nextJobId = nextSafeId(this._nextJobId)
      this._setState(state.PROCESSING)
      return accepted
    } catch (error) {
      this._activeJobId = previousJobId
      this._setState(previousState)
      throw createParakeetError(ERR_CODES.FAILED_TO_APPEND, error.message, error)
    }
  }

  _normalizeAudioInput (data) {
    if (!data) {
      throw new Error('Audio input is required')
    }
    if (data instanceof Float32Array) {
      return data
    }
    if (ArrayBuffer.isView(data)) {
      if (data instanceof Int16Array) {
        const audio = new Float32Array(data.length)
        for (let i = 0; i < data.length; i++) {
          audio[i] = data[i] / 32768.0
        }
        return audio
      }
      return new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4))
    }
    if (data instanceof ArrayBuffer) {
      return new Float32Array(data)
    }
    throw new Error('Unsupported audio input format')
  }

  _concatBufferedAudio () {
    if (this._bufferedAudio.length === 0) {
      return new Float32Array(0)
    }
    if (this._bufferedAudio.length === 1) {
      return this._bufferedAudio[0]
    }
    const totalLength = this._bufferedAudio.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of this._bufferedAudio) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return merged
  }
}

module.exports = { ParakeetInterface, QvacErrorAddonParakeet, ERR_CODES }
