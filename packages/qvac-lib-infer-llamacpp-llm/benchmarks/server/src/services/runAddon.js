'use strict'

const { InferenceArgsSchema } = require('../validation')
const { setLogger, releaseLogger } = require('@qvac/llm-llamacpp/addonLogging')
const { loadP2PModel } = require('./p2pModelLoader')
const { modelManager } = require('./modelManager')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

/**
 * Runs an addon with the given payload.
 * @param {Object} payload - The payload containing inputs, config, and P2P model parameters.
 * @returns {Promise<{ outputs: any[]; timings: { loadModelMs: number; runMs: number } }>} - A promise that resolves to the output and timings.
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

    const { inputs, config, systemPrompt } = InferenceArgsSchema.parse(payload)
    logger.debug(`Running addon with ${inputs.length} inputs`)

    // Use provided system prompt or fall back to default
    const defaultSystemPrompt = 'You are an AI assistant.'
    const effectiveSystemPrompt = systemPrompt || defaultSystemPrompt

    if (systemPrompt) {
      logger.debug(`Using custom system prompt: ${systemPrompt.substring(0, 50)}...`)
    }

    // Get or load model
    const loadStart = process.hrtime()

    let model

    // Check if this is a P2P model request (unified in config)
    const hyperdriveKey = config?.hyperdriveKey
    const modelName = config?.modelName
    const isP2PModel = hyperdriveKey && modelName

    if (isP2PModel) {
      logger.info('Loading P2P model using hyperdrive')
      logger.info(`Hyperdrive key: ${hyperdriveKey}`)
      logger.info(`Model name: ${modelName}`)
      logger.debug(`P2P params: hyperdriveKey=${hyperdriveKey}, modelName=${modelName}`)

      // Use P2P model loader with unified config
      model = await loadP2PModel({
        hyperdriveKey,
        modelName,
        modelConfig: config || {}
      })

      logger.info('P2P model loaded successfully')
    } else {
      // Direct LlmLlamacpp instantiation (local model approach)
      logger.info('Loading model directly with LlmLlamacpp')

      // Use config to determine model path and settings
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
        // Use ModelManager to get or reuse model instance
        model = await modelManager.getModel(modelPath, diskPath, localModelName, config)
        logger.info('Model ready for inference')
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

    const [loadSec, loadNano] = process.hrtime(loadStart)
    const loadModelMs = loadSec * 1e3 + loadNano / 1e6

    // -----------------------------
    // Benchmark run
    // -----------------------------
    const outputs = []
    const runStart = process.hrtime()

    for (const input of inputs) {
      const output = []
      const messages = [
        {
          role: 'system',
          content: effectiveSystemPrompt
        },
        { role: 'user', content: input }
      ]

      try {
        logger.debug('Calling model.run()...')
        const response = await model.run(messages)

        await response.onUpdate(data => {
          output.push(data)
        }).await()

        const outputString = output.join('')
        outputs.push(outputString)
        logger.debug(`Inference completed, output length: ${outputString.length}`)
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
    }
    const [runSec, runNano] = process.hrtime(runStart)
    const runMs = runSec * 1e3 + runNano / 1e6

    return {
      outputs,
      time: {
        loadModelMs,
        runMs
      }
    }
  } finally {
    // Always release C++ logger, even if there's an error
    releaseLogger()
    logger.info('C++ logger released')
  }
}

module.exports = {
  runAddon
}
