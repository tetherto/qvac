'use strict'

const path = require('bare-path')

/**
 * JavaScript wrapper around the native stable-diffusion.cpp addon.
 * Manages the native handle lifecycle and bridges JS ↔ C++.
 */
class SdInterface {
  /**
   * @param {object} binding - The native addon binding (from require.addon())
   * @param {object} configurationParams - Configuration for the SD context
   * @param {string} configurationParams.path - Local file path to the model weights
   * @param {object} [configurationParams.config] - SD-specific configuration options
   * @param {Function} outputCb - Called on any generation event (started, progress, output, error)
   */
  constructor (binding, configurationParams, outputCb) {
    this._binding = binding

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    // C++ getSubmap expects every config value to be a JS string.
    // Coerce numbers and booleans here so the native layer never sees non-string values.
    configurationParams.config = Object.fromEntries(
      Object.entries(configurationParams.config).map(([k, v]) => [k, String(v)])
    )

    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      outputCb
    )
  }

  /**
   * Moves addon to the LISTENING state after initialization.
   */
  async activate () {
    this._binding.activate(this._handle)
  }

  /**
   * Cancel the current generation job.
   */
  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  /**
   * Run a generation job with the given parameters.
   * @param {object} params - Generation parameters (will be JSON-serialized)
   * @returns {Promise<boolean>} true if job was accepted, false if busy
   */
  async runJob (params) {
    const paramsJson = JSON.stringify(params)
    return this._binding.runJob(this._handle, { type: 'text', input: paramsJson })
  }

  /**
   * Release model weights from memory (free_sd_ctx) without destroying the
   * instance. The instance can be reloaded by calling activate() again.
   */
  async unloadWeights () {
    if (!this._handle) return
    this._binding.unloadModel(this._handle)
  }

  /**
   * Destroy the native instance and release all resources.
   * After this the SdInterface object must not be used.
   */
  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

module.exports = { SdInterface }
