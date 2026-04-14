const { QvacErrorAddonWhisper, ERR_CODES } = require('./lib/error')
const { checkConfig } = require('./configChecker')

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  PAUSED: 'paused',
  STOPPED: 'stopped'
})

const END_OF_INPUT = 'end of job'

function nextSafeId (current) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
}

// 500 MB — ~2.7 hours of 16 kHz s16le mono audio
const MAX_BUFFERED_BYTES = 500 * 1024 * 1024

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class WhisperInterface {
  /**
   *
   * @param {Object} binding - the native binding object
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (binding, configurationParams, outputCb, transitionCb = null) {
    this._binding = binding
    this._outputCb = outputCb
    this._transitionCb = transitionCb
    this._nextJobId = 1
    this._activeJobId = null
    this._bufferedAudio = []
    this._bufferedBytes = 0
    this._state = state.LOADING
    this._audioFormat = configurationParams?.audio_format || 's16le'

    // Validate required configuration for whisper.cpp
    checkConfig(configurationParams)
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      this._addonOutputCallback.bind(this),
      transitionCb
    )
  }

  _setState (newState) {
    this._state = newState
    if (this._transitionCb) {
      this._transitionCb(this, newState)
    }
  }

  _addonOutputCallback (addon, event, data, error) {
    const isError = typeof error === 'string' && error.length > 0
    const isStats = data && typeof data === 'object' && (
      'totalTime' in data ||
      'audioDurationMs' in data ||
      'totalSamples' in data
    )
    const isTranscriptOutput = (
      (Array.isArray(data) && data.length > 0) ||
      (data && typeof data === 'object' && typeof data.text === 'string')
    )

    let mappedEvent = event
    if (event === 'Error' || isError || String(event).includes('Error')) {
      mappedEvent = 'Error'
    } else if (event === 'JobEnded' || isStats || String(event).includes('RuntimeStats')) {
      mappedEvent = 'JobEnded'
    } else if (event === 'Output' || isTranscriptOutput) {
      mappedEvent = 'Output'
    } else if (Array.isArray(data) && data.length === 0) {
      // WhisperModel::process returns an empty vector to avoid duplicate
      // segment emissions; skip forwarding this noop event.
      return
    }

    const jobId = this._activeJobId
    if (jobId === null) {
      return
    }

    if (mappedEvent === 'Output') {
      this._setState(state.PROCESSING)
    }

    if (this._outputCb != null) {
      this._outputCb(
        addon,
        mappedEvent,
        jobId,
        data,
        isError ? error : null
      )
    }

    if (mappedEvent === 'Error' || mappedEvent === 'JobEnded') {
      this._activeJobId = null
      this._setState(state.LISTENING)
    }
  }

  _emitSyntheticError (jobId, error) {
    if (this._outputCb == null) {
      return
    }
    this._outputCb(this, 'Error', jobId, undefined, error)
  }

  /**
   * Stops the current process execution,
   * frees memory allocated for configuration and weights,
   * and moves addon to the UNLOADED state.
   */
  async unload () {
    await this.destroyInstance()
  }

  /**
   * Moves addon the the LOADING state and loads configuration for the model.
   * Can only be invoked after unload()
   * @param {Object} configurationParams - all the required configuration for inference setup
   */
  async load (configurationParams) {
    checkConfig(configurationParams)
    this._audioFormat = configurationParams?.audio_format || this._audioFormat
    await this.destroyInstance()
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      this._addonOutputCallback.bind(this),
      this._transitionCb
    )
    this._setState(state.LOADING)
  }

  /**
   * Stops the current process execution,
   * frees memory allocated for configuration and weights,
   * loads the new configuration,
   * and moves addon to the LOADING state.
   * @param {Object} configurationParams - all the required configuration for inference setup
   */
  async reload (configurationParams) {
    checkConfig(configurationParams)
    this._audioFormat = configurationParams?.audio_format || this._audioFormat
    await this.cancel()

    if (typeof this._binding.reload === 'function') {
      // Native WhisperModel::setConfig handles fast in-place config updates and
      // only triggers a full context reload when fundamental context keys change
      // (model/use_gpu/flash_attn/gpu_device).
      await this._binding.reload(this._handle, configurationParams)
      this._setState(state.LOADING)
      return
    }

    // Fallback for older bindings without reload support.
    await this.load(configurationParams)
  }

  /**
   * Loads weights for the model.
   * Can only be invoked after instance is constructed or after load()/reload() are called
   * @param {Object} weightsData
   * @param {String} weightsData.filename
   * @param {Uint8Array} weightsData.contents
   * @param {Boolean} weightsData.completed
   */
  async loadWeights (weightsData) {
    try {
      this._binding.loadWeights(this._handle, weightsData)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Unloads weights for the model.
   * Can only be invoked after instance has loaded weights
   */
  async unloadWeights () {
    // Whisper bundles weights in the model file; keep API compatibility.
    return true
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  async activate () {
    try {
      this._binding.activate(this._handle)
      this._setState(state.LISTENING)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Pauses current inference process
   */
  async pause () {
    throw new QvacErrorAddonWhisper({
      code: ERR_CODES.FAILED_TO_PAUSE,
      adds: 'pause is not supported in runJob mode'
    })
  }

  /**
   * Stops current inference process
   */
  async stop () {
    throw new QvacErrorAddonWhisper({
      code: ERR_CODES.FAILED_TO_RESET,
      adds: 'stop is not supported in runJob mode'
    })
  }

  /**
   * Cancel a inference process by jobId, if no jobId is provided it cancel the whole queue
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
        await this._binding.cancel(this._handle)
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
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Adds new input to the processing queue
   * @param {Object} data
   * @param {String} data.type
   * @param {String} data.input
   * @returns {Number} - job ID
   */
  async append (data) {
    try {
      if (data?.type === END_OF_INPUT) {
        const currentJobId = this._nextJobId
        const input = this._concatBufferedAudio()
        const previousJobId = this._activeJobId
        const previousState = this._state

        let accepted = false
        try {
          accepted = this._binding.runJob(this._handle, {
            type: 'audio',
            input,
            audio_format: this._audioFormat
          })
        } catch (err) {
          this._activeJobId = previousJobId
          this._setState(previousState)
          throw err
        }
        if (!accepted) {
          this._activeJobId = previousJobId
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
        if (!(data.input instanceof Uint8Array)) {
          throw new Error('Audio input must be Uint8Array')
        }
        if (this._bufferedBytes + data.input.byteLength > MAX_BUFFERED_BYTES) {
          throw new QvacErrorAddonWhisper({
            code: ERR_CODES.BUFFER_LIMIT_EXCEEDED,
            adds: MAX_BUFFERED_BYTES + ' bytes'
          })
        }
        this._bufferedAudio.push(data.input)
        this._bufferedBytes += data.input.byteLength
        return this._nextJobId
      }

      throw new Error(`Unknown append input type: ${data?.type}`)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Addon process status
   * @returns {String}
   */
  async status () {
    try {
      return this._state
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_GET_STATUS,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Stops addon process and clears resources (including memory).
   */
  async destroyInstance () {
    // Already destroyed, nothing to do
    if (this._handle === null) {
      return
    }

    try {
      try {
        if (this._activeJobId !== null) {
          await this._binding.cancel(this._handle)
        }
      } catch {}
      this._binding.destroyInstance(this._handle)
      this._handle = null
      this._bufferedAudio = []
      this._bufferedBytes = 0
      this._activeJobId = null
      this._setState(state.IDLE)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }

  async runJob (data) {
    const currentJobId = this._nextJobId
    const previousJobId = this._activeJobId
    const previousState = this._state
    try {
      const accepted = this._binding.runJob(this._handle, {
        ...data,
        audio_format: data?.audio_format || this._audioFormat
      })
      if (!accepted) {
        this._activeJobId = previousJobId
        this._setState(previousState)
        return false
      }
      this._activeJobId = currentJobId
      this._nextJobId = nextSafeId(this._nextJobId)
      this._setState(state.PROCESSING)
      return true
    } catch (err) {
      this._activeJobId = previousJobId
      this._setState(previousState)
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: err.message,
        cause: err
      })
    }
  }

  startStreaming (config = {}) {
    try {
      this._activeJobId = this._nextJobId
      this._nextJobId = nextSafeId(this._nextJobId)
      this._setState(state.PROCESSING)
      this._binding.startStreaming(this._handle, {
        ...config,
        jobId: this._activeJobId
      })
    } catch (err) {
      this._activeJobId = null
      this._setState(state.LISTENING)
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_START_STREAMING,
        adds: err.message,
        cause: err
      })
    }
  }

  appendStreamingAudio (data) {
    try {
      if (!(data.input instanceof Uint8Array)) {
        throw new Error('Audio input must be Uint8Array')
      }
      this._binding.appendStreamingAudio(this._handle, {
        type: 'audio',
        input: data.input,
        audio_format: data.audio_format || this._audioFormat
      })
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_APPEND_STREAMING,
        adds: err.message,
        cause: err
      })
    }
  }

  endStreaming () {
    try {
      this._binding.endStreaming(this._handle)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_END_STREAMING,
        adds: err.message,
        cause: err
      })
    }
  }

  _concatBufferedAudio () {
    if (this._bufferedAudio.length === 0) {
      return new Uint8Array()
    }
    if (this._bufferedAudio.length === 1) {
      return this._bufferedAudio[0]
    }
    const totalLength = this._bufferedAudio.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0
    )
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of this._bufferedAudio) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }
}

module.exports = {
  WhisperInterface
}
