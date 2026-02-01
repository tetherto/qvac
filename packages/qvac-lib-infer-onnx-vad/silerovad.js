const { QvacErrorAddonSileroVad, ERR_CODES } = require('./lib/error')

let _globalBinding = null

/**
 * Sets the global binding object. Useful for testing.
 * @param {Object} binding - the binding object to use for native calls
 */
function setBinding (binding) {
  _globalBinding = binding
}

/**
 * Gets the global binding object, automatically requiring it if not set
 * @returns {Object} the binding object
 */
function getBinding () {
  if (_globalBinding === null) {
    _globalBinding = require('./binding')
  }
  return _globalBinding
}

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class SileroVadInterface {
  /**
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (configurationParams, outputCb, transitionCb = null) {
    this._binding = getBinding()
    this._handle = this._binding.createInstance(this, configurationParams, outputCb, transitionCb)
    if (!this._handle) {
      throw new QvacErrorAddonSileroVad(ERR_CODES.FAILED_TO_CREATE_INSTANCE)
    }
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  async activate () {
    try {
      this._binding.activate(this._handle)
    } catch (err) {
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.FAILED_TO_ACTIVATE,
        err.message
      )
    }
  }

  /**
   * Pauses current inference process
   */
  async pause () {
    try {
      this._binding.pause(this._handle)
    } catch (err) {
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.FAILED_TO_PAUSE,
        err.message
      )
    }
  }

  /**
   * Cancel an inference process by jobId, if no jobId is provided it cancel the whole queue
   */
  async cancel (jobId) {
    try {
      this._binding.cancel(this._handle, jobId)
    } catch (err) {
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.FAILED_TO_CANCEL,
        err.message
      )
    }
  }

  /**
   * Stop an inference process
   */
  async stop () {
    try {
      this._binding.stop(this._handle)
    } catch (err) {
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.FAILED_TO_STOP,
        err.message
      )
    }
  }

  /**
   * Adds new input to the processing queue
   * @param {ArrayBuffer} audioBuffer
   * @returns {Number} - job ID
   */
  async append (data) {
    if (data.type === 'arrayBuffer' && !(data.input instanceof ArrayBuffer)) {
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.DATA_NOT_ARRAY_BUFFER
      )
    }
    try {
      return this._binding.append(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.FAILED_TO_APPEND,
        err.message
      )
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
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.FAILED_TO_GET_STATUS,
        err.message
      )
    }
  }

  /**
   * Stops addon process and clears resources (including memory).
   */
  async destroy () {
    try {
      this._binding.destroyInstance(this._handle)
      this._handle = null
    } catch (err) {
      throw new QvacErrorAddonSileroVad(
        ERR_CODES.FAILED_TO_DESTROY,
        err.message
      )
    }
  }
}

module.exports = {
  SileroVadInterface,
  setBinding
}
