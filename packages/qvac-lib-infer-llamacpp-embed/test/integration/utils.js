'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const GGMLBert = require('../../index.js')
const FilesystemDL = require('@qvac/dl-filesystem')

/**
 * Downloads a file from a URL to a destination path
 * @param {string} url - The URL to download from
 * @param {string} dest - The destination file path
 * @returns {Promise<void>}
 */
async function downloadFile (url, dest) {
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => { if (!resolved) { resolved = true; resolve() } }
    const safeReject = (err) => { if (!resolved) { resolved = true; reject(err) } }

    const file = fs.createWriteStream(dest)

    file.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    const req = https.request(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            return safeReject(unlinkErr)
          }

          const redirectUrl = new URL(response.headers.location, url).href

          downloadFile(redirectUrl, dest)
            .then(safeResolve).catch(safeReject)
        })
        return
      }

      if (response.statusCode !== 200) {
        file.destroy()
        fs.unlink(dest, () => safeReject(new Error(`Download failed: ${response.statusCode}`)))
        return
      }

      response.on('error', (err) => {
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
      })

      response.pipe(file)
      file.on('close', () => {
        safeResolve()
      })
    })

    req.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    req.end()
  })
}

/**
 * Model configurations for testing
 */
const MODEL_CONFIGS = {
  'embeddinggemma-300M-Q8_0.gguf': {
    downloadUrl: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
    embeddingDimension: 768,
    maxContextSize: 2048
  },
  'gte-large_fp16.gguf': {
    downloadUrl: 'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
    embeddingDimension: 1024,
    maxContextSize: 512
  }
}

/**
 * Gets all available model configurations
 * @returns {Array<{modelName: string, config: Object}>}
 */
function getModelConfigs () {
  return Object.entries(MODEL_CONFIGS).map(([modelName, config]) => ({
    modelName,
    config
  }))
}

/**
 * Gets model configuration by name
 * @param {string} modelName - The model name
 * @returns {Object|null} The model configuration or null if not found
 */
function getModelConfig (modelName) {
  return MODEL_CONFIGS[modelName] || null
}

/**
 * Ensures the model file exists, downloading it if necessary
 * @param {string} modelName - The model name to ensure
 * @returns {Promise<[string, string]>} Returns [modelName, modelDir]
 */
async function ensureModel (modelName) {
  const modelDir = path.resolve(__dirname, '../model')
  const modelConfig = getModelConfig(modelName)

  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelName}`)
  }

  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    return [modelName, modelDir]
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`Downloading test model: ${modelName}...`)

  await downloadFile(modelConfig.downloadUrl, modelPath)

  const stats = fs.statSync(modelPath)
  console.log(`Model ready: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)

  return [modelName, modelDir]
}

/**
 * Simple test logger that outputs to console
 */
class TestLogger {
  error (...msgs) {
    console.error(msgs)
  }

  warn (...msgs) {
    console.warn(msgs)
  }

  debug (...msgs) {
    console.log(msgs)
  }

  info (...msgs) {
    console.log(msgs)
  }
}

/**
 * Creates a test instance of GGMLBert with the specified configuration
 * @param {Object} t - Test instance from brittle
 * @param {string} modelName - The model name to use
 * @param {string} device - Device to use: 'cpu' or 'gpu' (default: 'gpu')
 * @param {string} gpuLayers - Number of GPU layers (default: '999' for GPU, '0' for CPU)
 * @param {string} batchSize - Batch size (default: '1024')
 * @returns {Promise<{inference: GGMLBert, loader: FilesystemDL}>}
 */
async function createEmbeddingsTestInstance (t, modelName, device = 'gpu', gpuLayers = null, batchSize = '1024') {
  const [, modelDir] = await ensureModel(modelName)
  const diskPath = modelDir

  t.ok(fs.existsSync(path.join(diskPath, modelName)), 'Model file should exist')

  const loader = new FilesystemDL({ dirPath: diskPath })
  const logger = new TestLogger()

  // Force CPU on darwin-x64
  const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
  if (isDarwinX64) {
    device = 'cpu'
    console.log('Platform detected: darwin-x64, forcing device to CPU')
  }

  // Determine gpu_layers based on device if not explicitly provided
  const actualGpuLayers = gpuLayers !== null ? gpuLayers : (device === 'cpu' ? '0' : '999')

  // Build config object with device and gpu_layers parameters
  const config = {
    gpu_layers: actualGpuLayers,
    batch_size: batchSize
  }

  // Add device preference if specified
  if (device === 'cpu' || device === 'gpu') {
    config.device = device
  }

  // Disable flash attention on Android
  if (os.platform() === 'android') {
    config.flash_attn = 'off'
    console.log('Platform detected: Android, setting flash_attn to off')
  }

  config.openclCacheDir = diskPath

  const inference = new GGMLBert({ modelName, loader, logger, diskPath, opts: { stats: true } }, config)

  const t0 = Date.now()
  await inference.load()
  console.log(`  model.load() took ${Date.now() - t0} ms`)

  return { inference, loader }
}

/**
 * Extracts error message from various error formats
 * @param {Error|Object} error - The error object
 * @returns {string} The error message
 */
function extractErrorMessage (error) {
  if (!error) {
    return ''
  }

  // Error may be wrapped in EventEmitterError with the actual error in cause
  // error.cause can be a string or an Error object
  if (error?.cause) {
    return typeof error.cause === 'string' ? error.cause : error.cause.message || String(error.cause)
  }

  return error?.message || error?.toString() || String(error)
}

/**
 * Waits for a response to complete and handles errors
 * @param {Object} response - The inference response object
 * @returns {Promise<Array>} The generated embeddings
 */
async function waitForCompletion (response) {
  return await response._finishPromise
}

/**
 * Sets up error handlers on a response object
 * @param {Object} response - The inference response object
 * @param {Function} errorHandler - The error handler function
 */
function setupErrorHandlers (response, errorHandler) {
  response.on('error', errorHandler)
  response.on('failed', errorHandler)
}

/**
 * Removes error handlers from a response object
 * @param {Object} response - The inference response object
 */
function removeErrorHandlers (response) {
  response.removeAllListeners('error')
  response.removeAllListeners('failed')
}

/**
 * Cleans up test resources
 * @param {Object} loader - The loader instance
 * @param {Object} inference - The inference instance
 * @returns {Promise<void>}
 */
async function cleanupResources (loader, inference) {
  await loader.close()
  await inference.unload()
}

module.exports = {
  downloadFile,
  ensureModel,
  getModelConfigs,
  getModelConfig,
  MODEL_CONFIGS,
  TestLogger,
  createEmbeddingsTestInstance,
  extractErrorMessage,
  waitForCompletion,
  setupErrorHandlers,
  removeErrorHandlers,
  cleanupResources
}
