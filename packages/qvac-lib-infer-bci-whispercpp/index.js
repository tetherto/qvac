'use strict'

const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')

const { BCIInterface } = require('./bci')
const { QvacErrorAddonBCI, ERR_CODES } = require('./lib/error')
const { computeWER } = require('./lib/wer')

/**
 * BCI neural signal transcription client powered by whisper.cpp.
 *
 * Follows the same architecture as TranscriptionWhispercpp / LlmLlamacpp:
 * standalone class using createJobHandler + exclusiveRunQueue from
 * @qvac/infer-base.
 */
class BCIWhispercpp {
  /**
   * @param {Object} args
   * @param {Object} args.files - local model file paths
   * @param {string} args.files.model - path to the BCI GGML model file
   * @param {Object} [args.logger] - optional logger instance
   * @param {Object} [args.opts] - optional options (e.g. { stats: true })
   * @param {Object} config - inference configuration
   * @param {Object} config.whisperConfig - whisper decoding params
   * @param {Object} [config.bciConfig] - BCI-specific params (e.g. { day_idx: 1 })
   * @param {Object} [config.contextParams] - whisper context params
   * @param {Object} [config.miscConfig] - miscellaneous config
   */
  constructor ({ files, logger = null, opts = {} }, config = {}) {
    if (!files || typeof files.model !== 'string' || files.model.length === 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: 'files.model is required'
      })
    }

    if (!fs.existsSync(files.model)) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: files.model
      })
    }

    this._files = { model: files.model }
    this._config = config
    this.opts = opts
    this.logger = new QvacLogger(logger)
    this._withExclusiveRun = exclusiveRunQueue()
    this._inferenceQueueWaiter = Promise.resolve()
    this._job = createJobHandler({
      cancel: () => this.addon?.cancel()
    })

    this.addon = null
    this.state = {
      configLoaded: false,
      destroyed: false
    }
  }

  getState () {
    return this.state
  }

  async load () {
    if (this.state.destroyed) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: 'instance was destroyed'
      })
    }
    if (this.state.configLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
    this.state.configLoaded = true
  }

  async _load () {
    // BCI-tuned whisper defaults (beam_size, suppress_nst, temperature,
    // length_penalty, ...) are applied natively in
    // addon/src/model-interface/bci/BCIConfig.cpp::toWhisperFullParams.
    // Only the transport-level defaults live in JS; everything else is
    // delegated to the C++ layer to avoid double-specification.
    const whisperConfig = {
      language: 'en',
      n_threads: 0,
      ...(this._config.whisperConfig || {})
    }

    const configurationParams = {
      contextParams: {
        model: this._files.model,
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

    // Validation happens once inside BCIInterface's constructor via
    // configChecker.checkConfig. Calling it here too would duplicate the work.
    const binding = require('./binding')
    try {
      this.addon = new BCIInterface(
        binding,
        configurationParams,
        this._outputCallback.bind(this),
        this.logger.info.bind(this.logger)
      )
    } catch (err) {
      this.addon = null
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: err.message,
        cause: err
      })
    }

    await this.addon.activate()
    this.logger.info('BCI addon activated')
  }

  /**
   * Transcribe a neural signal from a binary file.
   * Convenience wrapper around transcribe().
   * @param {string} filePath - path to .bin neural signal file
   * @returns {Promise<QvacResponse>}
   */
  async transcribeFile (filePath) {
    const data = fs.readFileSync(filePath)
    return this.transcribe(new Uint8Array(data))
  }

  /**
   * Transcribe neural signal data (batch mode).
   * Returns a QvacResponse; use response.await() for the final output array,
   * response.onUpdate() for streaming updates, response.stats for runtime stats.
   * @param {Uint8Array} neuralData - binary neural signal
   * @returns {Promise<QvacResponse>}
   */
  async transcribe (neuralData) {
    return await this._enqueueInference(async () => {
      const response = this._job.start()

      let accepted
      try {
        accepted = await this.addon.runJob({ input: neuralData })
      } catch (err) {
        this._job.fail(err)
        throw err
      }
      if (!accepted) {
        const error = new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING })
        this._job.fail(error)
        throw error
      }

      const finalized = response.await()
      finalized.catch(() => {})
      response.await = () => finalized
      return response
    })
  }

  /**
   * Serialize inference runs so a second transcribe() waits until the first
   * response settles. Separate from _withExclusiveRun (lifecycle ops) so
   * destroy/unload can still preempt.
   */
  async _enqueueInference (runFn) {
    const prev = this._inferenceQueueWaiter
    let releaseSlot
    this._inferenceQueueWaiter = new Promise(resolve => { releaseSlot = resolve })
    await prev
    let response
    try {
      response = await runFn()
    } catch (err) {
      releaseSlot()
      throw err
    }
    response.await().finally(() => { releaseSlot() }).catch(() => {})
    return response
  }

  _outputCallback (addon, event, jobId, data, error) {
    if (event === 'Error') {
      this.logger.error('Job ' + jobId + ' failed with error: ' + error)
      this._job.fail(error)
      return
    }
    if (event === 'Output') {
      this._job.output(data)
      return
    }
    if (event === 'JobEnded') {
      this.logger.info('Job ' + jobId + ' completed')
      if (this.opts.stats) {
        this._job.end(data)
      } else {
        this._job.end()
      }
      return
    }
    this.logger.debug('Received event for job ' + jobId + ': ' + event)
  }

  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
    if (this._job.active) {
      this._job.fail(new Error('Job cancelled'))
    }
  }

  async unload () {
    return await this._withExclusiveRun(async () => {
      if (this.addon) {
        await this.addon.destroyInstance()
        this.addon = null
      }
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this.state.configLoaded = false
    })
  }

  async destroy () {
    return await this._withExclusiveRun(async () => {
      if (this.addon) {
        await this.addon.destroyInstance()
        this.addon = null
      }
      if (this._job.active) {
        this._job.fail(new Error('Model was destroyed'))
      }
      this.state.configLoaded = false
      this.state.destroyed = true
    })
  }
}

module.exports = BCIWhispercpp
module.exports.BCIWhispercpp = BCIWhispercpp
module.exports.computeWER = computeWER
