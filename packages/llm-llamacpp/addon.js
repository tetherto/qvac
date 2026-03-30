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
      outputCb,
      null
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
   * Cancel current inference job
   */
  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  /**
   * Run finetuning when native binding provides support.
   */
  async finetune (finetuningParams) {
    if (typeof this._binding.finetune !== 'function') {
      throw new Error('Finetuning is not exposed by this native binding')
    }
    if (finetuningParams === undefined) {
      throw new Error('Finetuning parameters are required')
    }
    return this._binding.finetune(this._handle, finetuningParams)
  }

  /**
   * Run one inference job with an array of message objects.
   * @param {Array<{type: string, input?: string, content?: Uint8Array}>} data - messages (text and/or media)
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
