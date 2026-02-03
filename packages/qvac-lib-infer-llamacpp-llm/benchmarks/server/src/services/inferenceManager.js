'use strict'

const InferenceManager = require('@tetherto/qvac-lib-manager-inference')
const logger = require('../utils/logger')

let inferenceManager = null
let loadedModel = null
let currentModelId = null

/**
 * Initializes and returns a singleton InferenceManager instance.
 * @returns {InferenceManager}
 */
const getInferenceManager = () => {
  if (inferenceManager) return inferenceManager

  inferenceManager = new InferenceManager()
  return inferenceManager
}

/**
 * Loads and caches a model instance
 * @param {Object} options - Model loading options
 * @returns {Promise<Object>} Model reference
 */
const loadModel = async (options) => {
  const { plugin, link, params, opts, config } = options
  // Ensure inference manager is initialized
  if (!inferenceManager) {
    inferenceManager = getInferenceManager()
  }
  // If we already have a model loaded with the same configuration, return it
  if (loadedModel && currentModelId) {
    logger.info('Using cached model instance')
    return { id: currentModelId }
  }
  logger.info('Loading new model instance')
  console.log(opts)
  const modelRef = await inferenceManager.loadModel({
    plugin,
    link,
    params,
    opts,
    config
  })

  loadedModel = inferenceManager.getModel({ id: modelRef.id })
  currentModelId = modelRef.id
  return modelRef
}

/**
 * Gets the cached model instance
 * @returns {Object} The model instance
 */
const getModel = () => {
  if (!loadedModel) {
    throw new Error('No model loaded. Call loadModel first.')
  }
  return loadedModel
}

module.exports = {
  getInferenceManager,
  loadModel,
  getModel
}
