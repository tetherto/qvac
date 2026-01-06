const path = require('bare-path')

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class LlamaInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (binding, configurationParams, outputCb, transitionCb = null) {
    this._binding = binding

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      outputCb,
      transitionCb
    )
  }

  /**
   *
   * @param {Object} weightsData
   * @param {String} weightsData.filename
   * @param {Uint8Array} weightsData.contents
   * @param {Boolean} weightsData.completed
   */
  async loadWeights (weightsData) {
    this._binding.loadWeights(this._handle, weightsData)
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  async activate () {
    this._binding.activate(this._handle)
  }

  /**
   * Pauses current inference process
   */
  async pause () {
    this._binding.pause(this._handle)
  }

  /**
   * Cancel a inference process by jobId, if no jobId is provided it cancel the whole queue
   */
  async cancel (jobId) {
    this._binding.cancel(this._handle, jobId)
  }

  /**
   * Adds new input to the processing queue
   * @param {Object} data
   * @param {String} data.type
   * @param {String} data.input
   * @returns {Number} - job ID
   */
  async append (data) {
    return this._binding.append(this._handle, data)
  }

  /**
   * Addon process status
   * @returns {String}
   */
  async status () {
    return this._binding.status(this._handle)
  }

  /**
   * Stops addon process and clears resources (including memory).
   */
  async destroyInstance () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }

  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }

  async stop () {
    this._binding.stop(this._handle)
  }
}

module.exports = {
  LlamaInterface
}
