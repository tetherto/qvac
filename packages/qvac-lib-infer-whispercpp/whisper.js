const { QvacErrorAddonWhisper, ERR_CODES } = require('./lib/error')
const { checkConfig } = require('./configChecker')

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class WhisperInterface {
  /**
   *
   * @param {Object} binding - the native binding object
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (binding, configurationParams, outputCb, transitionCb = null) {
    this._binding = binding
    // Validate required configuration for whisper.cpp
    checkConfig(configurationParams)
    this._handle = this._binding.createInstance(this, configurationParams, outputCb, transitionCb)
  }

  /**
   * Stops the current process execution,
   * frees memory allocated for configuration and weights,
   * and moves addon to the UNLOADED state.
   */
  async unload () {
    this._binding.unload(this._handle)
  }

  /**
   * Moves addon the the LOADING state and loads configuration for the model.
   * Can only be invoked after unload()
   * @param {Object} configurationParams - all the required configuration for inference setup
   */
  async load (configurationParams) {
    checkConfig(configurationParams)
    this._binding.load(this._handle, configurationParams)
  }

  /**
   * Stops the current process execution,
   * frees memory allocated for configuration and weights,
   * loads the new configuration,
   * and moves addon to the LOADING state.
   * @param {Object} configurationParams - all the required configuration for inference setup
   */
  async reload (configurationParams) {
    checkConfig(configurationParams)
    this._binding.reload(this._handle, configurationParams)
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
      this._binding.loadWeights(this._handle, weightsData)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Unloads weights for the model.
   * Can only be invoked after instance has loaded weights
   */
  async unloadWeights () {
    this._binding.unloadWeights(this._handle)
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  async activate () {
    try {
      this._binding.activate(this._handle)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
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
      this._binding.pause(this._handle)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_PAUSE,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Stops current inference process
   */
  async stop () {
    this._binding.stop(this._handle)
  }

  /**
   * Cancel a inference process by jobId, if no jobId is provided it cancel the whole queue
   */
  async cancel (jobId) {
    try {
      this._binding.cancel(this._handle, jobId)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: err.message,
        cause: err
      })
    }
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
      return this._binding.append(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
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
      return this._binding.status(this._handle)
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_GET_STATUS,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Stops addon process and clears resources (including memory).
   */
  async destroyInstance () {
    // Already destroyed, nothing to do
    if (this._handle === null) {
      return
    }

    try {
      this._binding.destroyInstance(this._handle)
      this._handle = null
    } catch (err) {
      throw new QvacErrorAddonWhisper({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }
}

module.exports = {
  WhisperInterface
}
