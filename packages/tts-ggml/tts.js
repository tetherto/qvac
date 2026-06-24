'use strict'

const { QvacErrorAddonTTSGgml, ERR_CODES } = require('./lib/error')

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class TTSInterface {
  /**
   * @param {Object} binding - the native binding object
   * @param {Object} configuration Optional initial configuration (engine-specific model paths, language, etc.)
   * @param {Function} outputCb - To be called on inference output events
   */
  constructor (binding, configuration = {}, outputCb = null) {
    this._binding = binding
    this._handle = this._binding.createInstance(this, configuration, outputCb)
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done.
   *
   * The C++ binding (addon_js::activate, registered in binding.cpp)
   * wraps `AddonCpp::activate()` in a JsAsyncTask::run worker thread so
   * the deferred GGUF parse (driven by
   * `IModelAsyncLoad::waitForLoadInitialization`) does not stall the JS
   * event loop.  The native call therefore returns a JS promise; awaiting
   * it here is what blocks `model.load()` until the worker finishes.
   */
  async activate () {
    try {
      await this._binding.activate(this._handle)
    } catch (err) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
  }

  /**
   * Enqueues a new TTS job
   * @param {Object} data
   * @param {String} data.type
   * @param {String} data.input
   */
  async runJob (data) {
    try {
      this._binding.runJob(this._handle, data)
    } catch (err) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: err.message,
        cause: err
      })
    }
  }

  async loadWeights (weightsData) {
    try {
      this._binding.loadWeights(this._handle, weightsData)
    } catch (err) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_LOAD,
        adds: err.message,
        cause: err
      })
    }
  }

  async cancel () {
    try {
      await this._binding.cancel(this._handle)
    } catch (err) {
      throw new QvacErrorAddonTTSGgml({
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
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: err.message,
        cause: err
      })
    }
  }

  async unload () {
    return this.destroyInstance()
  }
}

module.exports = {
  TTSInterface
}
