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
   * Pauses current inference process
   */
  async pause () {
    try {
      binding.pause(this._handle)
    } catch (err) {
      throw new QvacErrorAddonOcr({
        code: ERR_CODES.FAILED_TO_PAUSE,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Cancel an inference process by jobId, if no jobId is provided it cancel the whole queue
   */
  async cancel (jobId) {
    binding.cancel(this._handle)
  }

  /**
   * Stop an inference process
   */
  async stop () {
    binding.stop(this._handle)
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
      return binding.append(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonOcr({
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
      return binding.status(this._handle)
    } catch (err) {
      throw new QvacErrorAddonOcr({
        code: ERR_CODES.FAILED_TO_GET_STATUS,
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
