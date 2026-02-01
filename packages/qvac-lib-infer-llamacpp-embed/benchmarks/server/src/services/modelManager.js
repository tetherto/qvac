'use strict'

const EmbedLlamacpp = require('@qvac/embed-llamacpp')
const FilesystemDL = require('@qvac/dl-filesystem')
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
    const device = config?.device || 'cpu'
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
    // Create FilesystemDL for local model loading
    const loader = new FilesystemDL({
      dirPath: diskPath
    })

    // Build addon config string from parameters
    const configParts = []
    if (config?.gpu_layers) {
      configParts.push(`-ngl\t${config.gpu_layers}`)
    }
    if (config?.ctx_size) {
      configParts.push(`--ctx-size\t${config.ctx_size}`)
    }
    if (config?.batch_size) {
      configParts.push(`--batch-size\t${config.batch_size}`)
    }
    if (config?.verbosity) {
      configParts.push(`verbosity\t${config.verbosity}`)
    }
    const addonConfig = configParts.join('\n') || '-ngl\t99\n--ctx-size\t512\n--batch-size\t2048'

    logger.info(`Loading model with config: ${addonConfig.replace(/\n/g, ', ')}`)

    const model = new EmbedLlamacpp({
      diskPath,
      modelName: localModelName,
      loader,
      logger: {
        info: logger.info.bind(logger),
        error: logger.error.bind(logger),
        warn: logger.warn.bind(logger),
        debug: logger.debug.bind(logger)
      }
    }, addonConfig)

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
