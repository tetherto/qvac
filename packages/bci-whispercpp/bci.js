'use strict'

const { QvacErrorAddonBCI, ERR_CODES } = require('./lib/error')
const { ADDON_EVENT } = require('./lib/constants')
const { checkConfig } = require('./configChecker')

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle'
})

const END_OF_INPUT = 'end of job'

// Neural data is ~1 MB/s at 512ch * 50 Hz * 4 B, so 500 MB is ~8 minutes of
// signal. Matches transcription-whispercpp and guards against runaway
// producers between append() calls.
const MAX_BUFFERED_BYTES = 500 * 1024 * 1024

function nextSafeId(current) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
}

function isStatsPayload(data) {
  return (
    data &&
    typeof data === 'object' &&
    ('totalTime' in data || 'tokensPerSecond' in data || 'totalWallMs' in data)
  )
}

function isTranscriptPayload(data) {
  return (
    (Array.isArray(data) && data.length > 0) ||
    (data && typeof data === 'object' && typeof data.text === 'string')
  )
}

function isTranscriptArray(data) {
  return Array.isArray(data) && data.length > 0 && typeof data[0]?.text === 'string'
}

function isSingleTranscript(data) {
  return !Array.isArray(data) && data && typeof data === 'object' && typeof data.text === 'string'
}

function concatChunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
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
  constructor(binding, configurationParams, outputCb, transitionCb = null) {
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

  _setState(newState) {
    this._state = newState
    if (this._transitionCb) {
      this._transitionCb(this, newState)
    }
  }

  _addonOutputCallback(addon, event, data, error) {
    const mappedEvent = this._classifyEvent(event, data, error)
    if (mappedEvent === null) {
      return
    }

    const jobId = this._activeJobId
    if (jobId === null || jobId === undefined) {
      return
    }

    if (mappedEvent === ADDON_EVENT.OUTPUT) {
      this._setState(state.PROCESSING)
      this._emitOutput(addon, jobId, data)
      return
    }

    if (this._outputCb != null) {
      const errorText = typeof error === 'string' && error.length > 0 ? error : null
      this._outputCb(addon, mappedEvent, jobId, data, errorText)
    }

    if (mappedEvent === ADDON_EVENT.ERROR || mappedEvent === ADDON_EVENT.JOB_ENDED) {
      this._activeJobId = null
      this._setState(state.LISTENING)
    }
  }

  // Normalize the many raw native event shapes into a canonical ADDON_EVENT,
  // or null when the event carries nothing actionable (an empty array).
  _classifyEvent(event, data, error) {
    const hasErrorText = typeof error === 'string' && error.length > 0
    if (event === ADDON_EVENT.ERROR || hasErrorText || String(event).includes('Error')) {
      return ADDON_EVENT.ERROR
    }
    if (
      event === ADDON_EVENT.JOB_ENDED ||
      isStatsPayload(data) ||
      String(event).includes('RuntimeStats')
    ) {
      return ADDON_EVENT.JOB_ENDED
    }
    if (event === ADDON_EVENT.OUTPUT || isTranscriptPayload(data)) {
      return ADDON_EVENT.OUTPUT
    }
    if (Array.isArray(data) && data.length === 0) {
      return null
    }
    return event
  }

  _emitOutput(addon, jobId, data) {
    if (this._outputCb == null) {
      return
    }
    if (isTranscriptArray(data)) {
      this._emitSegments(addon, jobId, data)
    } else if (isSingleTranscript(data)) {
      this._outputCb(addon, ADDON_EVENT.OUTPUT, jobId, [data], null)
    } else {
      this._outputCb(addon, ADDON_EVENT.OUTPUT, jobId, data, null)
    }
  }

  _emitSegments(addon, jobId, segments) {
    for (const segment of segments) {
      this._outputCb(addon, ADDON_EVENT.OUTPUT, jobId, [segment], null)
    }
  }

  async unload() {
    await this.destroyInstance()
  }

  async load(configurationParams) {
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

  async reload(configurationParams) {
    checkConfig(configurationParams)
    await this.cancel()

    if (typeof this._binding.reload === 'function') {
      await this._binding.reload(this._handle, configurationParams)
      this._setState(state.LOADING)
      return
    }

    await this.load(configurationParams)
  }

  async loadWeights(weightsData) {
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

  async unloadWeights() {
    return true
  }

  async activate() {
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

  async cancel(jobId) {
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
  async append(data) {
    try {
      if (data?.type === END_OF_INPUT) {
        return this._flushBufferedSignal()
      }
      if (data?.type === 'neural') {
        return this._bufferNeuralChunk(data)
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

  _flushBufferedSignal() {
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
      accepted = this._binding.runJob(this._handle, { type: 'neural', input })
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

  _bufferNeuralChunk(data) {
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

  /**
   * Run a single batch job directly with neural signal data.
   * @param {Object} data
   * @param {Uint8Array} data.input - binary neural signal data
   */
  async runJob(data) {
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

  async status() {
    return this._state
  }

  async destroyInstance() {
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

  _concatBufferedSignal() {
    if (this._bufferedSignal.length === 0) {
      return new Uint8Array()
    }
    if (this._bufferedSignal.length === 1) {
      return this._bufferedSignal[0]
    }
    return concatChunks(this._bufferedSignal)
  }
}

BCIInterface.END_OF_INPUT = END_OF_INPUT

module.exports = { BCIInterface, END_OF_INPUT, MAX_BUFFERED_BYTES, nextSafeId, concatChunks }
