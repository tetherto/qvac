const path = require('bare-path')

/// An interface between Bare addon in C++ and JS runtime.
class BertInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   */
  constructor (binding, configurationParams, outputCb) {
    this._binding = binding

    if (!configurationParams.backendsDir) {
      configurationParams.backendsDir = path.join(__dirname, 'prebuilds')
    }

    this._handle = binding.createInstance(this, configurationParams, outputCb)
  } ///

  /**
   * Cancel current inference process. Resolves when the job has stopped.
   */
  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  /**
   * Processes new input
   * @param {Object} data
   * @param {String} data.type - Either 'text' for string input or 'sequences' for string array input
   * @param {String|Array<String>} data.input - Input text (for 'text') or array of texts (for 'sequences')
   * @returns {Promise<bool>} true if the job was accepted, false if busy
   */
  async runJob (data) {
    return this._binding.runJob(this._handle, data)
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
   * Stops addon process and clears resources (including memory).
   */
  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

module.exports = {
  BertInterface
}
