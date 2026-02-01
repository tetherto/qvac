const path = require('bare-path')

/// An interface between Bare addon in C++ and JS runtime.
class BertInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (binding, configurationParams, outputCb, transitionCb = null) {
    this._binding = binding

    if (!configurationParams.backendsDir) {
      configurationParams.backendsDir = path.join(__dirname, 'prebuilds')
    }

    this._handle = binding.createInstance(this, configurationParams, outputCb, transitionCb)
  } ///

  /**
   * Cancel a inference process by jobId, if no jobId is provided it cancel the whole queue
   */
  async cancel (jobId) {
    this._binding.cancel(this._handle, jobId)
  }

  /**
   * Adds new input to the processing queue
   * @param {Object} data
   * @param {String} data.type - Either 'text' for string input or 'end of job'
   * @param {String} data.input - The input text string (arrays are JSON stringified)
   * @returns {Promise<Number>} - job ID
   */
  async append (data) {
    return this._binding.append(this._handle, data)
  }

  /**
   * Addon process status
   * @returns {Promise<String>}
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

  /**
   * Loads model weights
   * @param {Object} data
   * @param {String} data.filename
   * @param {Buffer} data.contents
   * @param {Promise<Boolean>} data.completed
   */
  async loadWeights (data) {
    return this._binding.loadWeights(this._handle, data)
  }

  /**
   * Activates the model to start processing the queue
   */
  async activate () {
    return this._binding.activate(this._handle)
  }

  /**
   * Resets the model state
   */
  async reset () {
    return this._binding.reset(this._handle)
  }

  /**
   * Pauses the model processing
   */
  async pause () {
    return this._binding.pause(this._handle)
  }

  /**
   * Stops the model processing
   */
  async stop () {
    return this._binding.stop(this._handle)
  }

  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

module.exports = {
  BertInterface
}
