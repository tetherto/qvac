'use strict'

const binding = require('./binding')
const { QvacErrorAddonOcrGgml, ERR_CODES } = require('./lib/error')

/**
 * Thin wrapper around the C++ bare addon. Mirrors the surface of
 * `translation-nmtcpp`'s `marian.js` / `ocr-onnx`'s `ocr-fasttext.js`.
 */
class OcrGgmlInterface {
  /**
   * @param {Object} configurationParams - configuration for inference setup
   * @param {Function} outputCb - invoked on inference events (output, error, stats)
   * @param {Object|null} [transitionCb=null] - optional logger object with
   *   `info`/`warn`/`error`/`debug` methods. When provided, C++ log lines are
   *   forwarded via `binding.setLogger`.
   */
  constructor (configurationParams, outputCb, transitionCb = null) {
    this._handle = binding.createInstance(
      this,
      configurationParams,
      outputCb
    )

    this._loggerInitialized = false
    if (transitionCb && typeof transitionCb === 'object') {
      binding.setLogger((priority, message) => {
        const levels = ['error', 'warn', 'info', 'debug']
        const level = levels[priority] || 'info'
        if (typeof transitionCb[level] === 'function') {
          transitionCb[level](message)
        }
      })
      this._loggerInitialized = true
    }
  }

  async destroyInstance () {
    await this.destroy()
  }

  async unload () {
    await this.destroy()
  }

  /**
   * Moves the addon to LISTENING after construction-time work is finished.
   */
  async activate () {
    try {
      binding.activate(this._handle)
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
  }

  async cancel () {
    try {
      await binding.cancel(this._handle)
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Submit an OCR inference job.
   * @param {Object} data
   * @param {'image'} data.type
   * @param {Object} data.input - either `{ data, isEncoded: true }` for a
   *   raw JPEG/PNG buffer, or `{ data, width, height }` for raw RGB pixels.
   * @param {Object} [data.options]
   * @param {boolean} [data.options.paragraph]
   * @param {number} [data.options.boxMarginMultiplier]
   * @param {number[]} [data.options.rotationAngles]
   */
  async runJob (data) {
    try {
      return binding.runJob(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_RUN_JOB,
        adds: err.message,
        cause: err
      })
    }
  }

  async destroy () {
    if (this._handle === null) {
      return
    }

    try {
      if (this._loggerInitialized) {
        binding.releaseLogger()
        this._loggerInitialized = false
      }

      binding.destroyInstance(this._handle)
      this._handle = null
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }
}

module.exports = {
  OcrGgmlInterface
}
