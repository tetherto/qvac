'use strict'

const { QvacErrorAddonBCI, ERR_CODES } = require('./lib/error')
const { checkConfig } = require('./configChecker')

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle'
})

const END_OF_INPUT = 'end of job'

// Upper bound on buffered neural-signal bytes between append() calls.
// Neural data is ~1 MB/s at 512ch * 50 Hz * 4 B, so 500 MB ~= 8 minutes of
// signal. The bound matches qvac-lib-infer-whispercpp and protects against
// runaway producers.
const MAX_BUFFERED_BYTES = 500 * 1024 * 1024

function nextSafeId (current) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
}

/**
 * Low-level interface between the Bare C++ BCI addon and the JS runtime.
 * Accepts neural signal data (Uint8Array) instead of audio.
 */
class BCIInterface {
  /**
   * @param {Object} binding - the native binding object
   * @param {Object} configurationParams - configuration for the BCI model
   * @param {Function} outputCb - callback for inference events (Output, JobEnded, Error)
   * @param {Function} [transitionCb] - callback for state changes
   */
  constructor (binding, configurationParams, outputCb, transitionCb = null) {
    this._binding = binding
    this._outputCb = outputCb
    this._transitionCb = transitionCb
    this._nextJobId = 1
    this._activeJobId = null
    this._bufferedSignal = []
    this._bufferedBytes = 0
    this._state = state.LOADING

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
      'tokensPerSecond' in data ||
      'totalWallMs' in data
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
      return
    }

    const jobId = this._activeJobId
    if (jobId === null || jobId === undefined) {
      return
    }

    if (mappedEvent === 'Output') {
      this._setState(state.PROCESSING)

      if (this._outputCb != null) {
        const isTranscriptArray = Array.isArray(data) && data.length > 0 &&
          typeof data[0]?.text === 'string'
        const isSingleTranscript = !Array.isArray(data) &&
          data && typeof data === 'object' && typeof data.text === 'string'
        if (isTranscriptArray) {
          for (const segment of data) {
            this._outputCb(addon, 'Output', jobId, [segment], null)
          }
        } else if (isSingleTranscript) {
          this._outputCb(addon, 'Output', jobId, [data], null)
        } else {
          this._outputCb(addon, 'Output', jobId, data, null)
        }
      }
      return
    }

    if (this._outputCb != null) {
      this._outputCb(addon, mappedEvent, jobId, data, isError ? error : null)
    }

    if (mappedEvent === 'Error' || mappedEvent === 'JobEnded') {
      this._activeJobId = null
      this._setState(state.LISTENING)
    }
  }

  async unload () {
    await this.destroyInstance()
  }

  async load (configurationParams) {
    checkConfig(configurationParams)
    await this.destroyInstance()
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      this._addonOutputCallback.bind(this),
      this._transitionCb
    )
    this._setState(state.LOADING)
  }

  async reload (configurationParams) {
    checkConfig(configurationParams)
    await this.cancel()

    if (typeof this._binding.reload === 'function') {
      await this._binding.reload(this._handle, configurationParams)
      this._setState(state.LOADING)
      return
    }

    await this.load(configurationParams)
  }

  async loadWeights (weightsData) {
    try {
      this._binding.loadWeights(this._handle, weightsData)
    } catch (err) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: err.message,
        cause: err
      })
    }
  }

  async unloadWeights () {
    return true
  }

  async activate () {
    try {
      this._binding.activate(this._handle)
      this._setState(state.LISTENING)
    } catch (err) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
  }

  async cancel (jobId) {
    try {
      await this._binding.cancel(this._handle, jobId)
      this._bufferedSignal = []
      this._bufferedBytes = 0
      this._activeJobId = null
      this._setState(state.LISTENING)
    } catch (err) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Appends neural signal data to the processing buffer.
   * Send { type: 'end of job' } to trigger processing.
   * @param {Object} data
   * @param {string} data.type - 'neural' or 'end of job'
   * @param {Uint8Array} [data.input] - binary neural signal data
   * @returns {number} job ID
   */
  async append (data) {
    try {
      if (data?.type === END_OF_INPUT) {
        if (this._bufferedSignal.length === 0) {
          throw new QvacErrorAddonBCI({
            code: ERR_CODES.INVALID_NEURAL_INPUT,
            adds: 'no neural signal data was appended before end-of-job'
          })
        }
        const currentJobId = this._nextJobId
        const input = this._concatBufferedSignal()
        const previousState = this._state
        const previousJobId = this._activeJobId

        let accepted = false
        try {
          accepted = this._binding.runJob(this._handle, {
            type: 'neural',
            input
          })
        } catch (err) {
          this._activeJobId = previousJobId
          this._setState(previousState)
          throw err
        }
        if (!accepted) {
          this._activeJobId = previousJobId
          this._setState(previousState)
          throw new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING })
        }

        this._activeJobId = currentJobId
        this._nextJobId = nextSafeId(this._nextJobId)
        this._bufferedSignal = []
        this._bufferedBytes = 0
        this._setState(state.PROCESSING)
        return currentJobId
      }

      if (data?.type === 'neural') {
        if (!(data.input instanceof Uint8Array)) {
          throw new QvacErrorAddonBCI({
            code: ERR_CODES.INVALID_NEURAL_INPUT,
            adds: 'input must be Uint8Array'
          })
        }
        if (this._bufferedBytes + data.input.byteLength > MAX_BUFFERED_BYTES) {
          throw new QvacErrorAddonBCI({
            code: ERR_CODES.BUFFER_LIMIT_EXCEEDED,
            adds: MAX_BUFFERED_BYTES + ' bytes'
          })
        }
        this._bufferedSignal.push(data.input)
        this._bufferedBytes += data.input.byteLength
        return this._nextJobId
      }

      throw new Error(`Unknown append input type: ${data?.type}`)
    } catch (err) {
      if (err instanceof QvacErrorAddonBCI) throw err
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Run a single batch job directly with neural signal data.
   * @param {Object} data
   * @param {Uint8Array} data.input - binary neural signal data
   */
  async runJob (data) {
    if (!data || !(data.input instanceof Uint8Array)) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_NEURAL_INPUT,
        adds: 'runJob input must be a Uint8Array'
      })
    }
    if (data.input.byteLength === 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_NEURAL_INPUT,
        adds: 'runJob input must not be empty'
      })
    }

    const candidateJobId = this._nextJobId
    const previousState = this._state
    const previousJobId = this._activeJobId
    let accepted = false
    try {
      accepted = this._binding.runJob(this._handle, {
        type: 'neural',
        input: data.input
      })
    } catch (err) {
      this._activeJobId = previousJobId
      this._setState(previousState)
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_START_JOB,
        adds: err.message,
        cause: err
      })
    }

    if (!accepted) {
      this._activeJobId = previousJobId
      this._setState(previousState)
      return false
    }

    this._activeJobId = candidateJobId
    this._nextJobId = nextSafeId(this._nextJobId)
    this._setState(state.PROCESSING)
    return accepted
  }

  async status () {
    return this._state
  }

  async destroyInstance () {
    if (this._handle === null) {
      return
    }
    try {
      try {
        await this._binding.cancel(this._handle)
      } catch {}
      this._binding.destroyInstance(this._handle)
      this._handle = null
      this._bufferedSignal = []
      this._bufferedBytes = 0
      this._activeJobId = null
      this._setState(state.IDLE)
    } catch (err) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }

  _concatBufferedSignal () {
    if (this._bufferedSignal.length === 0) {
      return new Uint8Array()
    }
    if (this._bufferedSignal.length === 1) {
      return this._bufferedSignal[0]
    }
    const totalLength = this._bufferedSignal.reduce(
      (sum, chunk) => sum + chunk.byteLength, 0
    )
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of this._bufferedSignal) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }
}

BCIInterface.END_OF_INPUT = END_OF_INPUT

module.exports = { BCIInterface, END_OF_INPUT, MAX_BUFFERED_BYTES, nextSafeId }
