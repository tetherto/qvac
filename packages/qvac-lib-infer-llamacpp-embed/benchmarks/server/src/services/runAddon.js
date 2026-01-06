'use strict'

const { InferenceArgsSchema } = require('../validation')
const { spawn } = require('bare-subprocess')
const logger = require('../utils/logger')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')
const { Readable } = require('bare-stream')

class LocalLoader {
  constructor (modelDir) {
    this.modelDir = modelDir
  }

  async ready () {}
  async close () {}
  async getStream (filepath) {
    const fullPath = path.join(this.modelDir, filepath)
    return new Promise((resolve, reject) => {
      fs.readFile(fullPath, (err, buffer) => {
        if (err) {
          reject(new Error(`Failed to read file ${filepath}: ${err.message}`))
        } else {
          resolve(Readable.from([buffer]))
        }
      })
    })
  }
}

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
 * Ensure that `lib@version` is installed.
 * @param {string} lib - Package name
 * @param {string} requestedVersion - Requested version
 * @returns {Promise<string>} Installed version
 */
const ensurePackage = async (lib, requestedVersion) => {
  const installed = getPackageVersion(lib)
  if (installed && (!requestedVersion || installed === requestedVersion)) {
    return installed
  }
  const versionSpec = requestedVersion ? `@${requestedVersion}` : ''
  logger.info(`Installing ${lib}${versionSpec}...`)
  await new Promise((resolve, reject) => {
    const npm = spawn('npm', ['install', `${lib}${versionSpec}`], { stdio: 'inherit' })
    npm
      .on('exit', code => code === 0 ? resolve() : reject(new Error(`npm install ${lib}${versionSpec} failed (${code})`)))
      .on('error', reject)
  })
  const newVersion = getPackageVersion(lib)
  if (!newVersion) {
    throw new Error(`Failed to verify installation of ${lib}${versionSpec}`)
  }
  return newVersion
}

/**
 * Runs an addon with the given payload.
 * @param {Object} payload - The payload containing the input, library, link, params, opts, and config.
 * @returns {Promise<{ outputs: any[]; version: string; timings: { loadModelMs: number; runMs: number } }>} - A promise that resolves to the output, version, and timings.
 */
const runAddon = async (payload) => {
  const { inputs, lib, link, version: requestedVersion, params, opts, config } = InferenceArgsSchema.parse(payload)
  const version = await ensurePackage(lib, requestedVersion)
  const MLCBert = require(lib)
  logger.info(`Running addon with ${inputs.length} inputs`, {
    link: link || 'none',
    hasOpts: !!opts,
    hasParams: !!params
  })

  // -----------------------------
  // Benchmark loadModel
  // -----------------------------
  let modelRef = loadedModels.get(lib)
  let loadModelMs = 0
  const addonConfig = config?.addonConfig || '-ngl\t25\n--ctx-size\t512\n--batch-size\t512'

  if (!modelRef) {
    const loadStart = process.hrtime()

    const defaultModelPath = path.join(__dirname, '../../../models/gte-large_fp16.gguf')
    const modelPath = config?.modelFilePath ? path.resolve(config.modelFilePath) : defaultModelPath

    logger.info(`Model path: ${modelPath}`)
    logger.info(`Addon config: ${addonConfig}`)

    const loader = new LocalLoader(path.dirname(modelPath))
    const args = {
      loader,
      diskPath: path.dirname(modelPath),
      modelName: path.basename(modelPath)
    }

    try {
      modelRef = new MLCBert(args, addonConfig)
      await modelRef.load()
    } catch (error) {
      logger.error('Failed to load model', { error, stack: error.stack, modelPath, addonConfig })
      throw new Error(`Model loading failed: ${error.message}`)
    }

    const [loadSec, loadNano] = process.hrtime(loadStart)
    loadModelMs = loadSec * 1e3 + loadNano / 1e6
    loadedModels.set(lib, modelRef)
    logger.info(`Loaded new model for ${lib}`)
  }

  // -----------------------------
  // Benchmark run
  // -----------------------------
  const outputs = []
  const runStart = process.hrtime()

  const contextMatch = addonConfig.match(/-c\t(\d+)/) || addonConfig.match(/--ctx-size\t(\d+)/)
  const maxContextTokens = contextMatch ? parseInt(contextMatch[1]) : 512
  const maxChars = Math.floor(maxContextTokens * 0.3 * 3)

  logger.info(`Using max context: ${maxContextTokens} tokens (${maxChars} chars)`)

  for (const input of inputs) {
    let processedInput = input
    if (input.length > maxChars) {
      processedInput = input.substring(0, maxChars)
      logger.info(`Truncated input from ${input.length} to ${processedInput.length} characters`)
    }

    const response = await modelRef.run(processedInput)
    const embeddings = await response.await()

    if (!embeddings || !Array.isArray(embeddings) || !embeddings[0] || !embeddings[0][0]) {
      throw new Error('Invalid embeddings structure returned from model')
    }

    const actualEmbeddings = embeddings[0][0]
    const embeddingArray = Array.from(actualEmbeddings)
    outputs.push(embeddingArray)
  }

  const [runSec, runNano] = process.hrtime(runStart)
  const runMs = runSec * 1e3 + runNano / 1e6

  return {
    outputs,
    version,
    time: {
      loadModelMs,
      runMs
    }
  }
}

module.exports = {
  runAddon
}
