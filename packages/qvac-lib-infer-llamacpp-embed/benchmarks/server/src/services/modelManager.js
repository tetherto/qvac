'use strict'

const EmbedLlamacpp = require('@qvac/embed-llamacpp')
const path = require('bare-path')
const logger = require('../utils/logger')

/**
 * Model Manager - Singleton pattern for model instances
 * Ensures only ONE model is loaded in VRAM at a time
 */
class ModelManager {
  constructor () {
    this.currentModel = null
    this.currentModelKey = null
    this.loadPromise = null // Track in-progress loads
  }

  /**
   * Generate a unique key for a model configuration
   * Includes all parameters that affect model behavior
   */
  _generateModelKey (modelPath, config) {
    const device = config?.device === 'cpu' ? 'cpu' : 'gpu'
    const gpuLayers = config?.gpu_layers || '0'
    const ctxSize = config?.ctx_size || '512'
    const batchSize = config?.batch_size || '2048'
    return `${modelPath}:${device}:${gpuLayers}:${ctxSize}:${batchSize}`
  }

  /**
   * Get or create a model instance
   * Reuses existing model if config matches, otherwise unloads old and loads new
   */
  async getModel (modelPath, diskPath, localModelName, config) {
    const modelKey = this._generateModelKey(modelPath, config)

    // If same model is already loaded, reuse it
    if (this.currentModel && this.currentModelKey === modelKey) {
      logger.info('Reusing existing model instance')
      return this.currentModel
    }

    // If a different model is loaded, unload it first
    if (this.currentModel) {
      logger.info('Different model requested, unloading current model...')
      await this.unloadModel()
    }

    // If another request is currently loading, wait for it
    if (this.loadPromise) {
      logger.info('Waiting for in-progress model load...')
      await this.loadPromise
      // After waiting, check if it's the model we need
      if (this.currentModelKey === modelKey) {
        return this.currentModel
      }
      // Different model was loaded by the other request, unload it first
      if (this.currentModel) {
        logger.info('Loaded model differs from requested, unloading to free VRAM...')
        await this.unloadModel()
      }
    }

    // Load new model
    logger.info('Loading new model instance...')
    this.loadPromise = this._loadModel(modelPath, diskPath, localModelName, config)

    try {
      this.currentModel = await this.loadPromise
      this.currentModelKey = modelKey
      return this.currentModel
    } finally {
      this.loadPromise = null
    }
  }

  /**
   * Internal method to load a model
   */
  async _loadModel (modelPath, diskPath, localModelName, config) {
    // Build addon config map from parameters
    // Config is a map with string values: { gpu_layers: '25', ctx_size: '512', batch_size: '512' }
    const addonConfig = {}
    addonConfig.device = config?.device === 'cpu' ? 'cpu' : 'gpu'
    if (config?.gpu_layers != null && config.gpu_layers !== '') {
      addonConfig.gpu_layers = config.gpu_layers
    } else {
      addonConfig.gpu_layers = '99'
    }
    if (config?.ctx_size != null && config.ctx_size !== '') {
      addonConfig.ctx_size = config.ctx_size
    } else {
      addonConfig.ctx_size = '512'
    }
    if (config?.batch_size != null && config.batch_size !== '') {
      addonConfig.batch_size = config.batch_size
    } else {
      addonConfig.batch_size = '2048'
    }
    if (config?.verbosity != null && config.verbosity !== '') {
      addonConfig.verbosity = config.verbosity
    }

    logger.info(`Loading model with config: ${JSON.stringify(addonConfig)}`)

    const model = new EmbedLlamacpp({
      files: { model: [path.join(diskPath, localModelName)] },
      config: addonConfig,
      logger: {
        info: logger.info.bind(logger),
        error: logger.error.bind(logger),
        warn: logger.warn.bind(logger),
        debug: logger.debug.bind(logger)
      }
    })

    logger.info('Loading model into VRAM...')
    await model.load()
    logger.info('Model loaded successfully')

    return model
  }

  /**
   * Unload the current model and free VRAM
   */
  async unloadModel () {
    if (!this.currentModel) {
      return
    }

    logger.info('Unloading model from VRAM...')

    try {
      // Check if model has a close/unload method
      if (typeof this.currentModel.close === 'function') {
        await this.currentModel.close()
      } else if (typeof this.currentModel.unload === 'function') {
        await this.currentModel.unload()
      } else if (typeof this.currentModel.dispose === 'function') {
        await this.currentModel.dispose()
      }

      logger.info('Model unloaded successfully')
    } catch (error) {
      logger.warn(`Error during model unload: ${error.message}`)
    } finally {
      this.currentModel = null
      this.currentModelKey = null
    }
  }

  /**
   * Get status of currently loaded model
   */
  getStatus () {
    return {
      hasModel: !!this.currentModel,
      modelKey: this.currentModelKey,
      isLoading: !!this.loadPromise
    }
  }
}

// Export singleton instance
const modelManager = new ModelManager()

module.exports = {
  modelManager
}
