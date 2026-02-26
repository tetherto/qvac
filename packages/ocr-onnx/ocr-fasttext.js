const binding = require('./binding')
const { QvacErrorAddonOcr, ERR_CODES } = require('./lib/error')

class OcrFasttextInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (configurationParams, outputCb, transitionCb = null) {
    this._handle = binding.createInstance(this, configurationParams, outputCb, transitionCb)
  }

  /**
   *
   * @param {Object} weightsData
   * @param {String} weightsData.filename
   * @param {Uint8Array} weightsData.contents
   * @param {Boolean} weightsData.completed
   */
  async loadWeights (weightsData) {
    try {
      binding.loadWeights(this._handle, weightsData)
    } catch (err) {
      throw new QvacErrorAddonOcr({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  async activate () {
    try {
      binding.activate(this._handle)
    } catch (err) {
      throw new QvacErrorAddonOcr({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Cancel current inference process.
   */
  async cancel () {
    binding.cancel(this._handle)
  }

  /**
   * Processes new input
   * @param {Object} data
   * @param {String} data.type - Either 'image' for image input
   * @param {Object} data.input - The input image data
   * @param {Object} data.options - Optional processing options
   */
  async runJob (data) {
    try {
      return binding.runJob(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonOcr({
        code: ERR_CODES.FAILED_TO_RUN_JOB,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Stops addon process and clears resources (including memory).
   */
  async destroy () {
    try {
      binding.destroyInstance(this._handle)
      this._handle = null
    } catch (err) {
      throw new QvacErrorAddonOcr({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }

  async unload () {
    return this.destroy()
  }
}

module.exports = {
  OcrFasttextInterface
}
