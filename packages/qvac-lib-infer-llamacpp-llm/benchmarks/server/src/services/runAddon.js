'use strict'

const { InferenceArgsSchema } = require('../validation')
const { loadModel, getModel } = require('./inferenceManager')
const { loadP2PModel, getP2PModel } = require('./p2pModelLoader')
const logger = require('../utils/logger')

/**
 * Runs an addon with the given payload.
 * @param {Object} payload - The payload containing the input, library, link, params, opts, and config.
 * @returns {Promise<{ outputs: any[]; timings: { loadModelMs: number; runMs: number } }>} - A promise that resolves to the output and timings.
 */
const runAddon = async (payload) => {
  const { inputs, lib, link, params, opts, config, hyperdriveKey, modelName, modelConfig } = InferenceArgsSchema.parse(payload)
  logger.info(`Running addon with ${inputs.length} inputs`)

  // -----------------------------
  // Get or load model
  // -----------------------------
  const loadStart = process.hrtime()
  console.info('the opts: ')
  console.info(opts)

  let model

  if (hyperdriveKey && modelName) {
    // P2P model loading mode
    logger.info('=== P2P MODE DETECTED ===')
    logger.info(`HyperdriveKey: ${hyperdriveKey}`)
    logger.info(`ModelName: ${modelName}`)
    logger.info(`ModelConfig: ${JSON.stringify(modelConfig, null, 2)}`)

    logger.info('Calling loadP2PModel...')
    await loadP2PModel({
      hyperdriveKey,
      modelName,
      modelConfig
    })
    logger.info('loadP2PModel completed, getting model...')
    model = getP2PModel()
    logger.info('P2P model retrieved successfully')

    // Check addon status and activate if needed
    try {
      const addonStatus = await model.addon.status()
      logger.info(`Addon status: ${addonStatus}`)

      if (addonStatus !== 'listening' && addonStatus !== 'idle') {
        logger.info('Activating addon...')
        await model.addon.activate()
        logger.info('Addon activated successfully')
      }
    } catch (error) {
      logger.error('Error checking/activating addon status:', error)
    }
  } else {
    // Pre-installed model mode
    logger.info('Using pre-installed model mode')
    if (!lib) {
      throw new Error('lib parameter is required when not using P2P mode')
    }
    const plugin = require(lib)
    await loadModel({
      plugin,
      link,
      params,
      opts,
      config
    })
    model = getModel()
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
      { role: 'session', content: 'reset' },
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      { role: 'user', content: input }
    ]
    // Convert messages array to JSON string as expected by MLC Llama addon

    try {
      logger.info('Calling model.run()...')
      const response = await model.run(messages)
      logger.info('Model.run() completed, waiting for response...')

      logger.info('Setting up response.onUpdate()...')
      await response.onUpdate(data => {
        output.push(data)
      }).await()

      const outputString = output.join('')
      outputs.push(outputString)
      logger.info(`output: "${outputString}"`)
      logger.info(`Inference completed, output length: ${outputString.length}`)
    } catch (error) {
      logger.error('Error during model.run():', error)
      logger.error('Error stack:', error.stack)
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
}

module.exports = {
  runAddon
}
