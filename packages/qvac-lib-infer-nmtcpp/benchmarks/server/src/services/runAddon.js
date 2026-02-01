'use strict'
const process = require('bare-process')
const { InferenceArgsSchema } = require('../validation')
const logger = require('../utils/logger')
const {
  loadModel,
  translate,
  getModelBySrc
} = require('@qvac/sdk')
const ApiError = require('../utils/ApiError')
const { ERRORS } = require('../utils/constants')

const loadedModels = new Map()

/**
 * Get package version from package.json
 * @param {string} lib - Package name
 * @returns {string|null} Package version or null if not found
 */
const getPackageVersion = (lib) => {
  try {
    const packagePath = require.resolve(`${lib}/package`)
    const pkg = require(packagePath)
    return pkg.version
  } catch (error) {
    return null
  }
}

/**
 * Get QVAC SDK version
 * @returns {string} QVAC SDK version
 */
const getQvacSdkVersion = () => {
  return getPackageVersion('@qvac/sdk') || 'unknown'
}

/**
 * Runs an addon with the given payload.
 * @param {Object} payload - The payload containing the input, library, link, params, opts, and config.
 * @returns {Promise<{ outputs: any[]; timings: { loadModelMs: number | undefined; runMs: number } }>} - A promise that resolves to the output, version, and timings.
 */
const runAddon = async (payload) => {
  const { inputs, modelId, hyperDriveKey, params } = InferenceArgsSchema.parse(payload)
  const { srcLang, dstLang } = params
  let loadedMs
  logger.info(`Running addon with ${inputs.length} inputs`)
  let modelRef = loadedModels.get(`${modelId}-${hyperDriveKey}`)
  // -----------------------------
  // Benchmark loadModel
  // -----------------------------
  if (!modelRef) {
    const hDItem = getModelBySrc(modelId, hyperDriveKey)
    if (!hDItem) {
      logger.info(`Error loading model, can't find model with id ${modelId} for translation`)
      throw new ApiError(404, ERRORS.MODEL_NOT_FOUND)
    }
    const loadStart = process.hrtime()
    const id = await loadModel({
      modelSrc: `pear://${hDItem.hyperdriveKey}/${hDItem.modelId}`,
      modelType: 'nmt',
      modelConfig: {
        from: srcLang,
        to: dstLang
      },
      onProgress: (progress) => {
        console.log(progress)
      }
    })
    const [loadSec, loadNano] = process.hrtime(loadStart)
    loadedMs = loadSec * 1e3 + loadNano / 1e6
    logger.info(`Loaded model with id ${modelId} for translation, loaded in: ${loadedMs}ms`)
    loadedModels.set(`${modelId}-${hyperDriveKey}`, id)
    modelRef = id
  }
  // -----------------------------
  // Benchmark run
  // -----------------------------
  logger.info(`Running translation with model id ${modelId}`)
  const outputs = []
  const runStart = process.hrtime()
  for (const input of inputs) {
    const response = translate({
      modelId: modelRef,
      text: input,
      modelType: 'nmt',
      stream: false
    })
    const translation = await response.text
    outputs.push(translation)
  }
  const [runSec, runNano] = process.hrtime(runStart)
  const runMs = runSec * 1e3 + runNano / 1e6

  return {
    outputs,
    version: getQvacSdkVersion(),
    time: {
      loadedMs,
      runMs
    }
  }
}

module.exports = {
  runAddon
}
