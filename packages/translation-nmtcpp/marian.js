const binding = require('./binding')
const { QvacErrorAddonMarian, ERR_CODES } = require('./lib/error')

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class TranslationInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (configurationParams, outputCb, transitionCb = null) {
    this._handle = binding.createInstance(
      this,
      configurationParams,
      outputCb
    )

    // Set up C++ → JS logger
    this._loggerInitialized = false
    if (transitionCb && typeof transitionCb === 'object') {
      binding.setLogger((priority, message) => {
        // Map C++ priority levels to logger methods
        // Priority: ERROR=0, WARNING=1, INFO=2, DEBUG=3
        const levels = ['error', 'warn', 'info', 'debug']
        const level = levels[priority] || 'info'
        if (typeof transitionCb[level] === 'function') {
          transitionCb[level](message)
        }
      })
      this._loggerInitialized = true
    }
  }

  // For BaseInference.
  async destroyInstance () {
    await this.destroy()
  }

  /**
   * Stops addon process and clears resources (including memory).
   */
  async unload () {
    await this.destroy()
  }

  /**
   * Loads weights for the model.
   * Can only be invoked after instance is constructed or after load()/reload() are called
   * @param {Object} weightsData
   * @param {String} weightsData.filename
   * @param {Uint8Array} weightsData.contents
   * @param {Boolean} weightsData.completed
   */
  async loadWeights (weightsData) {
    try {
      binding.loadWeights(this._handle, weightsData)
    } catch (err) {
      throw new QvacErrorAddonMarian({
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
      throw new QvacErrorAddonMarian({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Cancel a inference process
   */
  async cancel () {
    try {
      await binding.cancel(this._handle)
    } catch (err) {
      throw new QvacErrorAddonMarian({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Submits a job to the processing pipeline
   * @param {Object} data
   * @param {String} data.type - 'text' for single input, 'sequences' for batch
   * @param {String | String[]} data.input
   * @returns {boolean} true if job was accepted
   */
  async runJob (data) {
    try {
      return binding.runJob(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonMarian({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Stops addon process and clears resources (including memory).
   */
  async destroy () {
    // If already destroyed, do nothing
    if (this._handle === null) {
      return
    }

    try {
      // Clean up logger before destroying instance
      if (this._loggerInitialized) {
        binding.releaseLogger()
        this._loggerInitialized = false
      }

      binding.destroyInstance(this._handle)
      this._handle = null
    } catch (err) {
      throw new QvacErrorAddonMarian({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }
}

module.exports = {
  TranslationInterface
}
