'use strict'

const { InferenceArgsSchema } = require('../validation')
const { setLogger, releaseLogger } = require('@qvac/embed-llamacpp/addonLogging')
const { loadP2PModel } = require('./p2pModelLoader')
const { modelManager } = require('./modelManager')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

/**
 * Runs an addon with the given payload.
 * @param {Object} payload - The payload containing inputs and config.
 * @returns {Promise<{ outputs: any[]; time: { loadModelMs: number; runMs: number } }>}
 */
const runAddon = async (payload) => {
  // Set up C++ logger (only log errors and warnings)
  setLogger((priority, message) => {
    const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'OFF']
    // Only log errors and warnings from C++
    if (priority <= 1) { // ERROR or WARN
      process.stderr.write(`[C++ ${levels[priority]}] ${message}\n`)
    }
  })

  try {
    logger.debug('runAddon called')
    logger.debug(`Payload keys: ${Object.keys(payload).join(', ')}`)

    const { inputs, config } = InferenceArgsSchema.parse(payload)
    logger.debug(`Running addon with ${inputs.length} inputs`)

    // Check if this is a P2P model request (hyperdriveKey present)
    const hyperdriveKey = config?.hyperdriveKey
    const modelName = config?.modelName
    const isP2PModel = hyperdriveKey && modelName

    let model
    let loadModelMs = 0

    if (isP2PModel) {
      logger.info('Loading P2P model using hyperdrive')
      logger.info(`Hyperdrive key: ${hyperdriveKey}`)
      logger.info(`Model name: ${modelName}`)

      // Start timer just before actual model loading
      const loadStart = process.hrtime()

      model = await loadP2PModel({
        hyperdriveKey,
        modelName,
        modelConfig: config || {}
      })

      const [loadSec, loadNano] = process.hrtime(loadStart)
      loadModelMs = loadSec * 1e3 + loadNano / 1e6

      logger.info(`P2P model loaded successfully in ${loadModelMs.toFixed(2)}ms`)
    } else {
      // Direct local model approach
      logger.info('Loading model directly with EmbedLlamacpp')

      const localModelName = config?.modelName
      const diskPath = config?.diskPath || './models/'

      if (!localModelName) {
        throw new Error('modelName is required in config for local GGUF models')
      }

      const modelPath = path.join(diskPath, localModelName)

      if (!fs.existsSync(modelPath)) {
        throw new Error(`Local model not found: ${modelPath}`)
      }

      logger.info(`Loading model: ${localModelName}`)

      try {
        // Start timer just before actual model loading
        const loadStart = process.hrtime()

        model = await modelManager.getModel(modelPath, diskPath, localModelName, config)

        const [loadSec, loadNano] = process.hrtime(loadStart)
        loadModelMs = loadSec * 1e3 + loadNano / 1e6

        logger.info(`Model ready for inference (loaded in ${loadModelMs.toFixed(2)}ms)`)
      } catch (error) {
        logger.error(`Error loading model ${localModelName}:`, {
          message: error.message,
          stack: error.stack,
          name: error.name,
          code: error.code,
          toString: String(error)
        })
        throw error
      }
    }

    // -----------------------------
    // Benchmark run - batch all inputs in a single call
    // -----------------------------
    const runStart = process.hrtime()

    try {
      logger.debug(`Processing ${inputs.length} inputs as batch`)

      // Pass ALL inputs as array - addon handles batching internally (much faster!)
      const response = await model.run(inputs)
      const embeddings = await response.await()

      if (!embeddings || !Array.isArray(embeddings) || !embeddings[0]) {
        throw new Error('Invalid embeddings structure returned from model')
      }

      // Extract embeddings array - structure is embeddings[0] = array of embeddings
      const batchEmbeddings = embeddings[0]
      const outputs = batchEmbeddings.map(emb => Array.from(emb))

      logger.debug(`Generated ${outputs.length} embeddings with ${outputs[0]?.length || 0} dimensions`)

      const [runSec, runNano] = process.hrtime(runStart)
      const runMs = runSec * 1e3 + runNano / 1e6
      const throughput = runMs > 0 ? (inputs.length / (runMs / 1000)).toFixed(1) : '0'

      logger.info(`Processed ${inputs.length} inputs in ${runMs.toFixed(2)}ms (${throughput} sent/s)`)

      return {
        outputs,
        time: {
          loadModelMs,
          runMs
        }
      }
    } catch (error) {
      logger.error('Error during model inference:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
        code: error.code,
        toString: String(error)
      })
      throw error
    }
  } finally {
    // Always release C++ logger, even if there's an error
    releaseLogger()
    logger.debug('C++ logger released')
  }
}

module.exports = {
  runAddon
}
