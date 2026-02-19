'use strict'

// Try to load QVAC error module, fallback to simple Error class
let QvacErrorAddonParakeet, ERR_CODES
try {
  const errorModule = require('./lib/error')
  QvacErrorAddonParakeet = errorModule.QvacErrorAddonParakeet
  ERR_CODES = errorModule.ERR_CODES
} catch (e) {
  // Fallback for standalone use without @qvac/error
  class SimpleParakeetError extends Error {
    constructor (code, message) {
      super(message)
      this.code = code
      this.name = 'QvacErrorAddonParakeet'
    }
  }
  QvacErrorAddonParakeet = SimpleParakeetError
  ERR_CODES = {
    FAILED_TO_LOAD_WEIGHTS: 7001,
    FAILED_TO_CANCEL: 7002,
    FAILED_TO_APPEND: 7003,
    FAILED_TO_GET_STATUS: 7004,
    FAILED_TO_DESTROY: 7005,
    FAILED_TO_ACTIVATE: 7006,
    FAILED_TO_RESET: 7007,
    FAILED_TO_PAUSE: 7008,
    MODEL_NOT_FOUND: 7009,
    INVALID_AUDIO_FORMAT: 7010,
    PREPROCESSOR_NOT_FOUND: 7011,
    VOCAB_NOT_FOUND: 7012,
    ENCODER_NOT_FOUND: 7013,
    DECODER_NOT_FOUND: 7014,
    INVALID_CONFIG: 7015
  }
}

/**
 * An interface between Bare addon in C++ and JS runtime.
 * Provides low-level access to the Parakeet speech-to-text model.
 */
class ParakeetInterface {
  /**
   * @param {Object} binding - the native binding object
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {string} configurationParams.modelPath - path to the model directory
   * @param {string} configurationParams.modelType - model type: 'tdt', 'ctc', 'eou', or 'sortformer'
   * @param {number} [configurationParams.maxThreads=4] - max CPU threads for inference
   * @param {boolean} [configurationParams.useGPU=false] - enable GPU acceleration
   * @param {number} [configurationParams.sampleRate=16000] - audio sample rate
   * @param {number} [configurationParams.channels=1] - audio channels (must be 1 for mono)
   * @param {boolean} [configurationParams.captionEnabled=false] - enable caption/subtitle mode
   * @param {boolean} [configurationParams.timestampsEnabled=true] - include timestamps in output
   * @param {number} [configurationParams.seed=-1] - random seed (-1 for random)
   * @param {Function} outputCallback - callback for transcription output events
   * @param {Function} [stateCallback] - callback for state transitions
   */
  constructor (binding, configurationParams, outputCallback, stateCallback = null) {
    this._binding = binding
    this._config = configurationParams
    this._outputCallback = outputCallback
    this._stateCallback = stateCallback
    this._handle = null

    // Create the native instance
    this._handle = this._binding.createInstance(
      'parakeet',
      this._config,
      this._outputCallback,
      this._stateCallback
    )
  }

  /**
   * Load model weights
   * @param {Object} weightsData - weight data chunk
   * @param {string} weightsData.filename - name of the weight file
   * @param {Uint8Array} weightsData.chunk - weight data chunk
   * @param {boolean} weightsData.completed - whether this is the last chunk
   * @param {number} [weightsData.progress] - loading progress percentage
   * @param {number} [weightsData.size] - total file size in bytes
   * @returns {Promise<boolean>}
   */
  async loadWeights (weightsData) {
    try {
      return this._binding.loadWeights(this._handle, weightsData)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_LOAD_WEIGHTS, error.message)
    }
  }

  /**
   * Activate the model for inference
   * @returns {Promise<void>}
   */
  async activate () {
    try {
      return this._binding.activate(this._handle)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_ACTIVATE, error.message)
    }
  }

  /**
   * Append audio data or end-of-job signal
   * @param {Object} data - data to append
   * @param {string} data.type - 'audio' or 'end of job'
   * @param {ArrayBuffer} [data.data] - audio data buffer (Float32, 16kHz mono)
   * @returns {Promise<number>} - job ID
   */
  async append (data) {
    try {
      return this._binding.append(this._handle, data)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_APPEND, error.message)
    }
  }

  /**
   * Get current model status
   * @returns {Promise<string>} - 'loading', 'listening', 'processing', 'idle', 'paused', 'stopped'
   */
  async status () {
    try {
      return this._binding.status(this._handle)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_GET_STATUS, error.message)
    }
  }

  /**
   * Pause processing
   * @returns {Promise<void>}
   */
  async pause () {
    try {
      return this._binding.pause(this._handle)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_PAUSE, error.message)
    }
  }

  /**
   * Stop processing and discard current job
   * @returns {Promise<void>}
   */
  async stop () {
    try {
      return this._binding.stop(this._handle)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_RESET, error.message)
    }
  }

  /**
   * Cancel a specific job
   * @param {number} jobId - job ID to cancel
   * @returns {Promise<void>}
   */
  async cancel (jobId) {
    try {
      return this._binding.cancel(this._handle, jobId)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_CANCEL, error.message)
    }
  }

  /**
   * Reload model configuration
   * @param {Object} configurationParams - new configuration
   * @returns {Promise<void>}
   */
  async reload (configurationParams) {
    try {
      return this._binding.reload(this._handle, configurationParams)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_RESET, error.message)
    }
  }

  /**
   * Unload model weights from memory
   * @returns {Promise<void>}
   */
  async unloadWeights () {
    try {
      return this._binding.unloadWeights(this._handle)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_RESET, error.message)
    }
  }

  /**
   * Destroy the addon instance and free resources
   * @returns {Promise<void>}
   */
  async destroyInstance () {
    try {
      return this._binding.destroyInstance(this._handle)
    } catch (error) {
      throw new QvacErrorAddonParakeet(ERR_CODES.FAILED_TO_DESTROY, error.message)
    }
  }
}

module.exports = { ParakeetInterface, QvacErrorAddonParakeet, ERR_CODES }
