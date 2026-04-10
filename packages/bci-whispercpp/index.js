'use strict'

const fs = require('bare-fs')

const { BCIInterface } = require('./bci')
const { checkConfig } = require('./configChecker')
const { QvacErrorAddonBCI, ERR_CODES } = require('./lib/error')

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
    this._jobToResponse = new Map()

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
      const segments = []
      let stats = null

      this._hasActiveResponse = true

      const tempCb = (addon, event, jid, data, error) => {
        if (event === 'Output') {
          if (Array.isArray(data)) {
            segments.push(...data)
          } else if (data && data.text) {
            segments.push(data)
          }
        } else if (event === 'JobEnded') {
          stats = data
          this._hasActiveResponse = false
          const text = segments.map(s => s.text).join('').trim()
          resolve({ text, segments, stats })
        } else if (event === 'Error') {
          this._hasActiveResponse = false
          reject(new Error(error || 'Transcription failed'))
        }
      }

      // Override addon output callback temporarily
      this._addon._outputCb = tempCb

      this._addon.runJob({ input: neuralData }).catch((err) => {
        this._hasActiveResponse = false
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

    return new Promise(async (resolve, reject) => {
      const segments = []
      let stats = null

      this._hasActiveResponse = true
      this._addon._outputCb = (addon, event, jid, data, error) => {
        if (event === 'Output') {
          if (Array.isArray(data)) {
            segments.push(...data)
          } else if (data && data.text) {
            segments.push(data)
          }
        } else if (event === 'JobEnded') {
          stats = data
          this._hasActiveResponse = false
          const text = segments.map(s => s.text).join('').trim()
          resolve({ text, segments, stats })
        } else if (event === 'Error') {
          this._hasActiveResponse = false
          reject(new Error(error || 'Transcription failed'))
        }
      }

      try {
        // Start a job
        await this._addon.append({ type: 'neural', input: new Uint8Array() })

        // Feed chunks
        for await (const chunk of signalStream) {
          await this._addon.append({
            type: 'neural',
            input: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          })
        }

        // Signal end
        await this._addon.append({ type: END_OF_INPUT })
      } catch (err) {
        this._hasActiveResponse = false
        reject(err)
      }
    })
  }

  _outputCallback (addon, event, jobId, data, error) {
    // Base callback - overridden per-call in transcribe/transcribeStream
  }

  async cancel () {
    if (this._addon?.cancel) {
      await this._addon.cancel()
    }
    this._hasActiveResponse = false
  }

  async destroy () {
    await this.cancel()
    if (this._addon) {
      await this._addon.destroyInstance()
    }
  }
}

/**
 * Compute Word Error Rate between hypothesis and reference.
 * @param {string} hypothesis
 * @param {string} reference
 * @returns {number} WER as a ratio (0.0 = perfect, 1.0 = 100% errors)
 */
function computeWER (hypothesis, reference) {
  const hyp = hypothesis.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const ref = reference.toLowerCase().trim().split(/\s+/).filter(Boolean)

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1

  const n = ref.length
  const m = hyp.length
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))

  for (let i = 0; i <= n; i++) dp[i][0] = i
  for (let j = 0; j <= m; j++) dp[0][j] = j

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        )
      }
    }
  }

  return dp[n][m] / n
}

module.exports = BCIWhispercpp
module.exports.BCIWhispercpp = BCIWhispercpp
module.exports.computeWER = computeWER
