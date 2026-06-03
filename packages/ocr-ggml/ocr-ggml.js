'use strict'

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
  constructor (binding, configurationParams, outputCb, transitionCb = null) {
    this._binding = binding
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      outputCb
    )

    this._loggerInitialized = false
    if (transitionCb && typeof transitionCb === 'object') {
      this._binding.setLogger((priority, message) => {
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
      this._binding.activate(this._handle)
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
      await this._binding.cancel(this._handle)
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
      return this._binding.runJob(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_RUN_JOB,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Returns the backend device the C++ pipeline resolved for inference.
   * @returns {{ requested: string, backendDevice: string, backendName: string, fallbackReason: string }}
   */
  getBackendInfo () {
    if (this._handle === null) {
      return null
    }
    return this._binding.getBackendInfo(this._handle)
  }

  async destroy () {
    if (this._handle === null) {
      return
    }

    try {
      if (this._loggerInitialized) {
        this._binding.releaseLogger()
        this._loggerInitialized = false
      }

      this._binding.destroyInstance(this._handle)
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
