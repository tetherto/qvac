'use strict'

const { QvacErrorAddonTTS, ERR_CODES } = require('./lib/error')

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class TTSInterface {
  /**
   * @param {Object} binding - the native binding object
   * @param {Object} configuration Optional initial configuration (e.g., modelPath, language, eSpeakDataPath)
   * @param {Function} outputCb - To be called on any inference event ( started, new output, error, etc )
   * @param {Function} transitionCb - To be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
   */
  constructor (binding, configuration = {}, outputCb = null, transitionCb = null) {
    this._binding = binding
    this._handle = this._binding.createInstance(this, configuration, outputCb, transitionCb)
  }

  /**
   * Stops the current process execution,
   * frees memory allocated for configuration and weights,
   * and moves addon to the UNLOADED state.
   */
  async unload () {
    try {
      this._binding.unload(this._handle)
    } catch (err) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_UNLOAD,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Moves addon the the LOADING state and loads configuration for the model.
   * Can only be invoked after unload()
   * @param {Object} configurationParams - all the required configuration for inference setup
   */
  async load (configurationParams) {
    try {
      this._binding.load(this._handle, configurationParams)
    } catch (err) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_LOAD,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Stops the current process execution,
   * frees memory allocated for configuration and weights,
   * loads the new configuration,
   * and moves addon to the LOADING state.
   * @param {Object} configurationParams - all the required configuration for inference setup
   */
  async reload (configurationParams) {
    try {
      this._binding.reload(this._handle, configurationParams)
    } catch (err) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_RELOAD,
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
      this._binding.activate(this._handle)
    } catch (err) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Adds new text to the processing queue
   * @param {Object} data
   * @param {String} data.type
   * @param {String} data.input
   * @returns {Number} - job ID
   */
  async append (data) {
    try {
      return this._binding.append(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonTTS({
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
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_GET_STATUS,
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
      return this._binding.pause(this._handle)
    } catch (err) {
      throw new QvacErrorAddonTTS({
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
    try {
      return this._binding.stop(this._handle)
    } catch (err) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_STOP,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Cancel a inference process by jobId, if no jobId is provided it cancel the whole queue
   */
  async cancel (jobId) {
    try {
      this._binding.cancel(this._handle, jobId)
    } catch (err) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_CANCEL,
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
      const h = this._handle
      this._handle = null
      return this._binding.destroyInstance(h)
    } catch (err) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }
}

module.exports = {
  TTSInterface
}
