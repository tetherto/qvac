'use strict'

const fs = require('bare-fs')

const { BCIInterface } = require('./bci')
const { checkConfig } = require('./configChecker')
const { QvacErrorAddonBCI, ERR_CODES } = require('./lib/error')
const { computeWER } = require('./lib/wer')

const END_OF_INPUT = 'end of job'

/**
 * High-level BCI transcription client powered by whisper.cpp.
 * Accepts neural signal streams and returns text transcriptions.
 */
class BCIWhispercpp {
  /**
   * @param {Object} args
   * @param {string} args.modelPath - path to whisper GGML model file
   * @param {Object} [args.logger] - optional logger
   * @param {Object} config - inference configuration
   * @param {Object} config.whisperConfig - whisper decoding params
   * @param {Object} [config.bciConfig] - BCI-specific params
   * @param {Object} [config.contextParams] - whisper context params
   */
  constructor ({ modelPath, logger = null }, config = {}) {
    this._modelPath = modelPath
    this._logger = logger || { debug () {}, info () {}, warn () {}, error () {} }
    this._config = config
    this._addon = null
    this._hasActiveResponse = false
    this._pendingResolve = null
    this._pendingReject = null
    this._segments = []
    this._stats = null

    if (!this._modelPath || !fs.existsSync(this._modelPath)) {
      throw new Error(`Model file doesn't exist: ${this._modelPath}`)
    }
  }

  /**
   * Load and activate the model.
   */
  async load () {
    const whisperConfig = {
      language: 'en',
      temperature: 0.0,
      suppress_nst: true,
      n_threads: 0,
      ...(this._config.whisperConfig || {})
    }

    const configurationParams = {
      contextParams: {
        model: this._modelPath,
        ...(this._config.contextParams || {})
      },
      whisperConfig,
      miscConfig: {
        caption_enabled: false,
        ...(this._config.miscConfig || {})
      }
    }

    if (this._config.bciConfig) {
      configurationParams.bciConfig = this._config.bciConfig
    }

    checkConfig(configurationParams)

    const binding = require('./binding')
    this._addon = new BCIInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this._logger.info.bind(this._logger)
    )

    await this._addon.activate()
    this._logger.info('BCI addon activated')
  }

  /**
   * Transcribe a neural signal from a binary file.
   * Binary format: [uint32 numTimesteps, uint32 numChannels, float32[] data]
   * @param {string} filePath - path to .bin neural signal file
   * @returns {Promise<Object>} - { text, segments, stats }
   */
  async transcribeFile (filePath) {
    const data = fs.readFileSync(filePath)
    return this.transcribe(new Uint8Array(data))
  }

  /**
   * Transcribe neural signal data (batch mode).
   * @param {Uint8Array} neuralData - binary neural signal
   * @returns {Promise<Object>} - { text, segments, stats }
   */
  async transcribe (neuralData) {
    if (this._hasActiveResponse) {
      throw new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING })
    }

    return new Promise((resolve, reject) => {
      this._beginJob(resolve, reject)

      this._addon.runJob({ input: neuralData }).catch((err) => {
        this._clearJob()
        reject(err)
      })
    })
  }

  /**
   * Streaming transcription: accepts an async iterable of neural signal chunks.
   * Each chunk is appended and processing starts on end-of-stream.
   * @param {AsyncIterable<Uint8Array>} signalStream
   * @returns {Promise<Object>} - { text, segments, stats }
   */
  async transcribeStream (signalStream) {
    if (this._hasActiveResponse) {
      throw new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING })
    }

    const promise = new Promise((resolve, reject) => {
      this._beginJob(resolve, reject)
    })

    try {
      await this._addon.append({ type: 'neural', input: new Uint8Array() })

      for await (const chunk of signalStream) {
        await this._addon.append({
          type: 'neural',
          input: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        })
      }

      await this._addon.append({ type: END_OF_INPUT })
    } catch (err) {
      this._clearJob()
      throw err
    }

    return promise
  }

  _beginJob (resolve, reject) {
    this._segments = []
    this._stats = null
    this._hasActiveResponse = true
    this._pendingResolve = resolve
    this._pendingReject = reject
  }

  _clearJob () {
    this._hasActiveResponse = false
    this._pendingResolve = null
    this._pendingReject = null
  }

  _outputCallback (addon, event, jobId, data, error) {
    if (event === 'Output') {
      if (Array.isArray(data)) {
        this._segments.push(...data)
      } else if (data && data.text) {
        this._segments.push(data)
      }
    } else if (event === 'JobEnded') {
      this._stats = data
      const segments = this._segments
      const stats = this._stats
      const resolve = this._pendingResolve
      this._clearJob()
      if (resolve) {
        const text = segments.map(s => s.text).join('').trim()
        resolve({ text, segments, stats })
      }
    } else if (event === 'Error') {
      const reject = this._pendingReject
      this._clearJob()
      if (reject) {
        reject(new Error(error || 'Transcription failed'))
      }
    }
  }

  async cancel () {
    if (this._addon?.cancel) {
      await this._addon.cancel()
    }
    this._clearJob()
  }

  async destroy () {
    await this.cancel()
    if (this._addon) {
      await this._addon.destroyInstance()
    }
  }
}

module.exports = BCIWhispercpp
module.exports.BCIWhispercpp = BCIWhispercpp
module.exports.computeWER = computeWER
