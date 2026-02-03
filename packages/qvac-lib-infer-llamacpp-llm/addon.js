/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class LlamaInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   */
  constructor (binding, configurationParams, outputCb, transitionCb = null, finetuningParams = null) {
    this._binding = binding
    const args = [
      this,
      configurationParams,
      outputCb,
      transitionCb ?? null
    ]
    if (finetuningParams !== null && finetuningParams !== undefined) {
      args.push(finetuningParams)
    }
    this._handle = this._binding.createInstance(...args)
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
  async cancel (jobId) {
    if (!this._handle) return
    await this._binding.cancel(this._handle, jobId)
  }

  /**
   * Run finetuning when native binding provides support.
   */
  async finetune (finetuningParams) {
    if (typeof this._binding.finetune !== 'function') {
      throw new Error('Finetuning is not exposed by this native binding')
    }
    if (finetuningParams !== undefined) {
      return this._binding.finetune(this._handle, finetuningParams)
    }
    return this._binding.finetune(this._handle)
  }

  /**
   * Return addon status when native binding provides support.
   */
  async status () {
    if (typeof this._binding.status !== 'function') {
      return 'UNKNOWN'
    }
    return this._binding.status(this._handle)
  }

  /**
   * Request training pause when native binding provides support.
   */
  async pause () {
    if (typeof this._binding.pause !== 'function') {
      throw new Error('Pause is not exposed by this native binding')
    }
    return this._binding.pause(this._handle)
  }

  /**
   * Adds new input to the processing queue.
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
