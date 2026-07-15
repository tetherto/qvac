'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const GGMLBert = require('../../index.js')

const TRANSIENT_ERROR_CODES = new Set([
  // DNS / name resolution
  'EAI_NODATA',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ENOTFOUND',
  // connectivity — these dominate mobile Device Farm flakiness: a transient
  // network drop surfaces as ENETUNREACH/EHOSTUNREACH and MUST be retried.
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  // mid-transfer / timeout
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ESIZE',
  // post-transfer: request "resolved" but the .part is missing/short or could
  // not be finalized (truncated/interrupted) — retry instead of hard-failing.
  'EINCOMPLETE'
])

function isTransientError(err) {
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) return true
  if (err.statusCode) {
    const s = err.statusCode
    return s === 408 || s === 429 || s >= 500
  }
  return false
}

function urlHost(url) {
  try {
    return new URL(url).host
  } catch (_) {
    return url
  }
}

async function downloadFileOnce(url, dest, opts = {}) {
  const { timeoutMs = 30_000, idleTimeoutMs = 30_000, maxRedirects = 10, _redirectCount = 0 } = opts
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => {
      if (!resolved) {
        resolved = true
        resolve()
      }
    }
    const safeReject = (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    const reqTimer = setTimeout(() => {
      req.destroy(
        Object.assign(new Error(`Request timeout after ${timeoutMs}ms from ${urlHost(url)}`), {
          code: 'ETIMEDOUT'
        })
      )
    }, timeoutMs)

    const req = https.request(url, (response) => {
      clearTimeout(reqTimer)

      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        if (_redirectCount >= maxRedirects) {
          fs.unlink(dest, () =>
            safeReject(new Error(`Too many redirects (max ${maxRedirects}) from ${urlHost(url)}`))
          )
          return
        }
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') return safeReject(unlinkErr)
          const redirectUrl = new URL(response.headers.location, url).href
          downloadFileOnce(redirectUrl, dest, { ...opts, _redirectCount: _redirectCount + 1 })
            .then(safeResolve)
            .catch(safeReject)
        })
        return
      }

      if (response.statusCode !== 200) {
        const err = Object.assign(
          new Error(`Download failed: HTTP ${response.statusCode} from ${urlHost(url)}`),
          { statusCode: response.statusCode }
        )
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
        return
      }

      let idleTimer = null
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          response.destroy(
            Object.assign(
              new Error(`Response idle timeout after ${idleTimeoutMs}ms from ${urlHost(url)}`),
              { code: 'ETIMEDOUT' }
            )
          )
        }, idleTimeoutMs)
      }
      resetIdle()
      response.on('data', resetIdle)
      response.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer)
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
      })

      response.pipe(file)
      file.on('close', () => {
        if (idleTimer) clearTimeout(idleTimer)
        safeResolve()
      })
    })

    req.on('error', (err) => {
      clearTimeout(reqTimer)
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })
    req.end()
  })
}

async function downloadFileWithRetries(urls, dest, opts = {}) {
  const { retries = 3, minBytes = 1, ...downloadOpts } = opts
  const urlList = Array.isArray(urls) ? urls : [urls]
  const partPath = dest + '.part'

  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = urlList[attempt % urlList.length]
    const host = urlHost(url)
    try {
      await downloadFileOnce(url, partPath, downloadOpts)

      // A "resolved" download whose .part is missing or short means the
      // transfer was truncated/interrupted — surface it as EINCOMPLETE so the
      // loop RETRIES instead of hard-failing on a fatal ENOENT from statSync.
      let size = -1
      try {
        size = fs.statSync(partPath).size
      } catch (_) {
        size = -1
      }
      if (size < minBytes) {
        throw Object.assign(
          new Error(
            `Incomplete download from ${host} (${size < 0 ? 'missing .part' : size + ' bytes'})`
          ),
          { code: 'EINCOMPLETE' }
        )
      }

      try {
        fs.renameSync(partPath, dest)
      } catch (err) {
        throw Object.assign(
          new Error(`Failed to finalize download from ${host}: ${err.code || err.message}`),
          { code: 'EINCOMPLETE' }
        )
      }
      return
    } catch (err) {
      try {
        fs.unlinkSync(partPath)
      } catch (_) {}

      const attemptsLeft = retries - attempt
      if (!isTransientError(err) || attemptsLeft === 0) {
        console.error(
          `[download] Failed after ${attempt + 1} attempt(s) from ${host}: ${err.code || err.message}`
        )
        throw err
      }

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30_000)
      console.log(
        `[download] Attempt ${attempt + 1}/${retries + 1} failed (${err.code || err.statusCode}) from ${host}, retrying in ${Math.round(delay)}ms...`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

const downloadFile = downloadFileWithRetries

/**
 * Model configurations for testing
 */
const MODEL_CONFIGS = {
  'embeddinggemma-300M-Q8_0.gguf': {
    downloadUrl:
      'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
    embeddingDimension: 768,
    maxContextSize: 2048
  },
  'gte-large_fp16.gguf': {
    downloadUrl:
      'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
    embeddingDimension: 1024,
    maxContextSize: 512
  }
}

/**
 * Gets all available model configurations
 * @returns {Array<{modelName: string, config: Object}>}
 */
function getModelConfigs() {
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
function getModelConfig(modelName) {
  return MODEL_CONFIGS[modelName] || null
}

// Android Device Farm pre-staging: the device's network to huggingface.co is
// unreliable, but the Device Farm HOST has solid network. The test-spec
// pre_test phase downloads each model on the host and `adb push`es it here; when
// a model is already staged we skip the on-device download entirely.
//
// /data/local/tmp is the one location that is both adb-writable from the host
// AND readable by the app process (the harness already pushes testFilter.txt
// here). The app's own scoped dirs reject adb access on Android 11+, so they
// cannot be used for host pre-staging.
const PRESTAGED_MODEL_DIR = '/data/local/tmp/prestaged-models'

function prestagedModelDir(modelName) {
  if (os.platform() !== 'android') return null
  try {
    const p = path.join(PRESTAGED_MODEL_DIR, modelName)
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return PRESTAGED_MODEL_DIR
  } catch (_) {}
  return null
}

/**
 * Ensures the model file exists, downloading it if necessary
 * @param {string} modelName - The model name to ensure
 * @returns {Promise<[string, string]>} Returns [modelName, modelDir]
 */
async function ensureModel(modelName) {
  const modelDir = path.resolve(__dirname, '../model')
  const modelConfig = getModelConfig(modelName)

  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelName}`)
  }

  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath)
    if (stat.size > 0) {
      return [modelName, modelDir]
    }
    console.log(`[download] Removing zero-byte cached file: ${modelName}`)
    fs.unlinkSync(modelPath)
  }

  // Pre-staged path (Android): copy the host-staged model from the read-only
  // staging dir into the normal (writable) modelDir, then return. The copy is a
  // fast local operation (no network). Returning a writable dir matters —
  // load() writes sibling files next to the model (e.g. openclCacheDir).
  const staged = prestagedModelDir(modelName)
  if (staged) {
    fs.mkdirSync(modelDir, { recursive: true })
    console.log(`[prestage] Using pre-staged model ${modelName} (copying into writable modelDir)`)
    fs.copyFileSync(path.join(staged, modelName), modelPath)
    const stat = fs.statSync(modelPath)
    if (stat.size === 0) {
      fs.unlinkSync(modelPath)
      throw new Error(`[prestage] copied model ${modelName} is empty`)
    }
    return [modelName, modelDir]
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`[download] Downloading test model: ${modelName}...`)

  await downloadFileWithRetries(modelConfig.downloadUrl, modelPath)

  const stat = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)

  return [modelName, modelDir]
}

/**
 * Simple test logger that outputs to console
 */
class TestLogger {
  error(...msgs) {
    console.error(msgs)
  }

  warn(...msgs) {
    console.warn(msgs)
  }

  debug(...msgs) {
    console.log(msgs)
  }

  info(...msgs) {
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
 * @returns {Promise<{inference: GGMLBert}>}
 */
async function createEmbeddingsTestInstance(
  t,
  modelName,
  device = 'gpu',
  gpuLayers = null,
  batchSize = '1024'
) {
  const [, modelDir] = await ensureModel(modelName)
  const modelPath = path.join(modelDir, modelName)

  t.ok(fs.existsSync(modelPath), 'Model file should exist')

  const logger = new TestLogger()

  // Force CPU on darwin-x64
  const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
  if (isDarwinX64) {
    device = 'cpu'
    console.log('Platform detected: darwin-x64, forcing device to CPU')
  }

  const actualGpuLayers = gpuLayers !== null ? gpuLayers : device === 'cpu' ? '0' : '999'

  const config = {
    gpu_layers: actualGpuLayers,
    batch_size: batchSize
  }

  if (device === 'cpu' || device === 'gpu') {
    config.device = device
  }

  if (os.platform() === 'android') {
    config.flash_attn = 'off'
    console.log('Platform detected: Android, setting flash_attn to off')
  }

  config.openclCacheDir = modelDir

  const inference = new GGMLBert({
    files: { model: [modelPath] },
    config,
    logger,
    opts: { stats: true }
  })

  const t0 = Date.now()
  await inference.load()
  console.log(`  model.load() took ${Date.now() - t0} ms`)

  return { inference }
}

/**
 * Extracts error message from various error formats
 * @param {Error|Object} error - The error object
 * @returns {string} The error message
 */
function extractErrorMessage(error) {
  if (!error) {
    return ''
  }

  // Error may be wrapped in EventEmitterError with the actual error in cause
  // error.cause can be a string or an Error object
  if (error?.cause) {
    return typeof error.cause === 'string'
      ? error.cause
      : error.cause.message || String(error.cause)
  }

  return error?.message || error?.toString() || String(error)
}

/**
 * Waits for a response to complete and handles errors
 * @param {Object} response - The inference response object
 * @returns {Promise<Array>} The generated embeddings
 */
async function waitForCompletion(response) {
  return await response._finishPromise
}

/**
 * Sets up error handlers on a response object
 * @param {Object} response - The inference response object
 * @param {Function} errorHandler - The error handler function
 */
function setupErrorHandlers(response, errorHandler) {
  response.on('error', errorHandler)
  response.on('failed', errorHandler)
}

/**
 * Removes error handlers from a response object
 * @param {Object} response - The inference response object
 */
function removeErrorHandlers(response) {
  response.removeAllListeners('error')
  response.removeAllListeners('failed')
}

/**
 * Cleans up test resources
 * @param {Object} inference - The inference instance
 * @returns {Promise<void>}
 */
async function cleanupResources(inference) {
  await inference.unload()
}

const test = require('brittle')

function safeTest(name, opts, fn) {
  test(name, opts, async (t) => {
    try {
      await fn(t)
    } catch (err) {
      console.error(err)
      t.fail(`${name}: ${err.message}`)
    }
  })
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
  cleanupResources,
  safeTest
}
