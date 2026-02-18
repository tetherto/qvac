const path = require('bare-path')

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class LlamaInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   */
  constructor (binding, configurationParams, outputCb) {
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
      outputCb
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
   * Cancel current task
   */
  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  /**
   * @param {Object} data
   * @param {String} data.type
   * @param {String} data.input
   */
  async runJob (data) {
    return this._binding.runJob(this._handle, data)
  }

  /**
   * Unload the model and clear resources (including memory).
   */
  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

module.exports = {
  LlamaInterface
}
