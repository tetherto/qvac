'use strict'

const LlmLlamacpp = require('@qvac/llm-llamacpp')
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
   */
  _generateModelKey (modelPath, config) {
    const device = config?.device || 'cpu'
    const gpuLayers = config?.gpu_layers || '0'
    const ctxSize = config?.ctx_size || '8192'
    return `${modelPath}:${device}:${gpuLayers}:${ctxSize}`
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
    const model = new LlmLlamacpp({
      files: { model: [path.join(diskPath, localModelName)] },
      config: {
        device: config?.device,
        gpu_layers: config?.gpu_layers,
        ctx_size: config?.ctx_size,
        temp: config?.temp,
        top_p: config?.top_p,
        top_k: config?.top_k,
        n_predict: config?.n_predict,
        repeat_penalty: config?.repeat_penalty,
        seed: config?.seed,
        verbosity: '3'
      },
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
