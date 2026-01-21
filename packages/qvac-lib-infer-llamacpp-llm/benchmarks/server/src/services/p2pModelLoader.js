'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('@qvac/llm-llamacpp')
const logger = require('../utils/logger')
const path = require('bare-path')

// --- Simplified P2P Infrastructure (based on quickstart.js) ---
const storeDir = path.resolve(__dirname, '../../../store')
const store = new Corestore(storeDir)
const hdStore = store.namespace('hd')

// --- Model Management ---
let p2pModel = null
let p2pModelId = null
let isLoading = false
let loadingPromise = null

/**
 * Loads a model using P2P (Hyperdrive) approach
 * @param {Object} options - P2P loading options
 * @returns {Promise<Object>} Model instance
 */
const loadP2PModel = async (options) => {
  const { hyperdriveKey, modelName, modelConfig } = options
  if (!hyperdriveKey || !modelName) {
    const errMsg = 'Both hyperdriveKey and modelName must be provided.'
    logger.error(errMsg)
    throw new Error(errMsg)
  }

  const device = modelConfig?.device || 'cpu'
  const gpuLayers = modelConfig?.gpu_layers || '0'
  const ctxSize = modelConfig?.ctx_size || '8192'
  const modelId = `${hyperdriveKey}-${modelName}:${device}:${gpuLayers}:${ctxSize}`

  logger.info('=== loadP2PModel called ===')
  logger.info(`Options: ${JSON.stringify(options, null, 2)}`)
  logger.info(`Model ID: ${modelId}`)
  logger.info(`ModelConfig: ${JSON.stringify(modelConfig, null, 2)}`)

  // If already loading the same model, wait for that to complete
  if (isLoading && loadingPromise && p2pModelId === modelId) {
    logger.info('Model is already loading, waiting for completion...')
    try {
      const result = await loadingPromise
      return result
    } catch (error) {
      logger.error('Previous loading attempt failed:', error)
      // Continue with new loading attempt
    }
  }

  // Check if we already have a model loaded
  if (p2pModel) {
    logger.info(`Existing model found with ID: ${p2pModelId}`)
    logger.info(`Requested model ID: ${modelId}`)
    if (p2pModelId === modelId) {
      logger.info('✅ Using cached P2P model instance (same model)')
      return p2pModel
    } else {
      logger.info('⚠️ Different model requested, will unload current model')
      try {
        await p2pModel.unload()
        logger.info('Previous model unloaded successfully')
      } catch (error) {
        logger.error('Error unloading previous model:', error)
      }
      p2pModel = null
      p2pModelId = null
    }
  } else {
    logger.info('No existing model found, will load new model')
  }

  // Set loading state and promise
  isLoading = true
  loadingPromise = (async () => {
    logger.info('Loading new P2P model instance')
    logger.info(`Hyperdrive key: ${hyperdriveKey}`)
    logger.info(`Model name: ${modelName}`)

    // Create a Hyperdrive Dataloader instance for this model
    const hdDL = new HyperDriveDL({
      key: hyperdriveKey,
      store: hdStore
    })
    logger.info('HyperDriveDL created successfully')

    // Wait for hyperdrive to be ready
    logger.info('Waiting for HyperDriveDL to be ready...')
    await hdDL.ready()
    logger.info('HyperDriveDL is ready')

    // Create a LlmLlamacpp instance
    const args = {
      loader: hdDL,
      logger: {
        info: logger.info.bind(logger),
        error: logger.error.bind(logger),
        warn: logger.warn.bind(logger),
        debug: logger.debug.bind(logger)
      },
      modelName,
      diskPath: './models'
    }

    // Explicitly pass all model parameters to ensure they reach the C++ addon
    const config = {
      device: modelConfig?.device,
      gpu_layers: modelConfig?.gpu_layers,
      ctx_size: modelConfig?.ctx_size,
      temp: modelConfig?.temp,
      top_p: modelConfig?.top_p,
      top_k: modelConfig?.top_k,
      n_predict: modelConfig?.n_predict,
      repeat_penalty: modelConfig?.repeat_penalty,
      seed: modelConfig?.seed,
      verbosity: '3'
    }
    logger.info('LlmLlamacpp config prepared:', JSON.stringify(config, null, 2))
    logger.info('Instantiating LlmLlamacpp...')
    const model = new LlmLlamacpp(args, config)
    logger.info('LlmLlamacpp instance created')

    // Load model with progress callback
    logger.info('Loading model...')
    const closeLoader = true
    const reportProgressCallback = (report) => {
      if (typeof report === 'object') {
        logger.info(`${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`)
      }
    }
    await model.load(closeLoader, reportProgressCallback)
    logger.info('Model loaded successfully!')

    // Cache the model
    p2pModel = model
    p2pModelId = modelId

    return model
  })()

  try {
    const model = await loadingPromise
    return model
  } catch (error) {
    logger.error('Failed to load P2P model:', error)
    throw error
  } finally {
    isLoading = false
    loadingPromise = null
  }
}

const getP2PModel = () => {
  if (!p2pModel) {
    throw new Error('No P2P model loaded. Call loadP2PModel first.')
  }
  return p2pModel
}

const isModelLoading = () => {
  return isLoading
}

const clearP2PModel = () => {
  if (p2pModel) {
    try {
      p2pModel.unload()
      logger.info('✅ P2P model unloaded and cache cleared')
    } catch (error) {
      logger.error('Error unloading P2P model:', error)
    }
    p2pModel = null
    p2pModelId = null
  }
  isLoading = false
  loadingPromise = null
}

const getModelStatus = () => {
  return {
    isLoaded: !!p2pModel,
    modelId: p2pModelId,
    isLoading
  }
}

module.exports = {
  loadP2PModel,
  getP2PModel,
  isModelLoading,
  clearP2PModel,
  getModelStatus,
  store,
  hdStore
}
