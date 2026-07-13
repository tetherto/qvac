'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const crypto = require('bare-crypto')

// Lazily loaded: requiring index.js pulls in the native binding, which isn't
// needed for the model download/integrity helpers and lets those run in unit
// tests without a compiled addon.
function getGGMLBert() {
  return require('../../index.js')
}

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

const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, 'models.manifest.json')
let _manifestCache

// Loads and caches the model manifest (single source of truth for model URLs +
// sha256/bytes integrity). The default manifest is mandatory so packaging or
// parsing errors cannot silently disable integrity checks.
//
// The default path is loaded via a literal require() rather than fs.readFileSync.
// Mobile builds pack this file into a single bundle via bare-pack, which follows
// static require()/import calls. A dynamic fs.readFileSync call is invisible to
// that traversal and drops the manifest from the bundle, so model lookup fails
// on-device even though the file was present at build time.
function validateManifest(manifest, source) {
  if (!manifest || typeof manifest !== 'object' || !manifest.models) {
    throw new Error(`Required model manifest is invalid (${source}): missing models object`)
  }
  return manifest
}

function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  if (manifestPath === DEFAULT_MANIFEST_PATH) {
    if (_manifestCache !== undefined) return _manifestCache
    try {
      _manifestCache = validateManifest(
        require('./models.manifest.json'),
        'test/integration/models.manifest.json'
      )
    } catch (err) {
      throw new Error(`Failed to load required model manifest: ${err.message}`)
    }
    return _manifestCache
  }
  try {
    return validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifestPath)
  } catch (err) {
    throw new Error(`Failed to load required model manifest "${manifestPath}": ${err.message}`)
  }
}

function resolveModelEntry(modelName, { manifest } = {}) {
  const m = manifest !== undefined ? manifest : loadManifest()
  validateManifest(m, manifest !== undefined ? 'explicit manifest override' : 'default manifest')
  const entry = m.models[modelName]
  if (!entry) {
    throw new Error(`Model "${modelName}" is missing from required models.manifest.json`)
  }
  if (!Array.isArray(entry.urls) || entry.urls.length === 0) {
    throw new Error(`Model "${modelName}" has no source URL in models.manifest.json`)
  }
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
    throw new Error(`Model "${modelName}" has no valid SHA-256 pin in models.manifest.json`)
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
    throw new Error(`Model "${modelName}" has no valid byte-size pin in models.manifest.json`)
  }
  return entry
}

// Streaming sha256 via the package's direct bare-crypto dependency.
async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
  })
}

// Verifies a model file against a manifest entry. Byte-length is checked first
// (cheap) so a size mismatch fails fast before hashing a multi-GB file.
// { ok: true } when it passes (or when no integrity value is pinned yet).
async function verifyModelFile(filePath, entry, hashFile = sha256File) {
  let stats
  try {
    stats = fs.statSync(filePath)
  } catch (err) {
    return { ok: false, reason: `stat failed: ${err.message}` }
  }
  if (stats.size === 0) return { ok: false, reason: 'zero-byte file' }

  if (entry && Number.isInteger(entry.bytes) && stats.size !== entry.bytes) {
    return { ok: false, reason: `size ${stats.size} != expected ${entry.bytes}` }
  }

  const hasSha = entry && typeof entry.sha256 === 'string' && entry.sha256.length === 64
  if (hasSha) {
    let got
    try {
      got = await hashFile(filePath)
    } catch (err) {
      return { ok: false, reason: `sha256 failed: ${err.message}` }
    }
    if (typeof got !== 'string' || !/^[0-9a-f]{64}$/i.test(got)) {
      return { ok: false, reason: 'sha256 failed: no valid digest returned' }
    }
    if (got !== entry.sha256.toLowerCase()) {
      return { ok: false, reason: `sha256 ${got} != expected ${entry.sha256}` }
    }
    return { ok: true }
  }

  return { ok: true, skipped: true }
}

const _verificationCache = new Map()

function verificationKey(filePath, entry) {
  const stats = fs.statSync(filePath)
  const mtimeMs =
    typeof stats.mtimeMs === 'number'
      ? stats.mtimeMs
      : stats.mtime && typeof stats.mtime.getTime === 'function'
        ? stats.mtime.getTime()
        : 0
  return [
    filePath,
    stats.dev,
    stats.ino,
    stats.size,
    mtimeMs,
    entry.sha256.toLowerCase(),
    entry.bytes
  ].join(':')
}

async function verifyModelFileOnce(filePath, entry, hashFile = sha256File) {
  let key
  try {
    key = verificationKey(filePath, entry)
  } catch (err) {
    return { ok: false, reason: `stat failed: ${err.message}` }
  }

  let verification = _verificationCache.get(key)
  if (!verification) {
    verification = verifyModelFile(filePath, entry, hashFile)
    _verificationCache.set(key, verification)
  }
  const result = await verification
  if (!result.ok) _verificationCache.delete(key)
  return result
}

function resetVerificationCache() {
  _verificationCache.clear()
}

// Counts real download attempts so warm-vs-cold behaviour is unit-testable.
let _downloadCount = 0
function getDownloadCount() {
  return _downloadCount
}
function resetDownloadCount() {
  _downloadCount = 0
}

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

async function copyPrestagedModel({ stagedDir, modelName, modelPath, entry }) {
  fs.copyFileSync(path.join(stagedDir, modelName), modelPath)
  const res = await verifyModelFileOnce(modelPath, entry)
  if (!res.ok) {
    try {
      fs.unlinkSync(modelPath)
    } catch (_) {}
    throw new Error(`[prestage] copied model ${modelName} failed integrity: ${res.reason}`)
  }
}

/**
 * Ensures the model file exists, downloading it if necessary
 * @param {Object} opts
 * @param {string} opts.modelName - The model name to ensure
 * @returns {Promise<[string, string]>} Returns [modelName, modelDir]
 */
// The standalone default modelDir assignment is patched by the mobile test
// packager to point at a writable app directory. Keep this shape stable.
async function ensureModel({ modelName, modelDir: modelDirOverride, manifest, download } = {}) {
  const modelDir = path.resolve(__dirname, '../model')
  const dir = modelDirOverride || modelDir
  const modelConfig = getModelConfig(modelName)

  // Model URL + sha256/bytes come exclusively from models.manifest.json (by
  // modelName). The manifest is also the cache key for
  // .github/actions/cache-models. `modelDir`, `manifest`, and `download`
  // overrides exist for unit testing, but still require a fully pinned entry.
  const entry = resolveModelEntry(modelName, manifest !== undefined ? { manifest } : {})

  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelName}`)
  }

  const modelPath = path.join(dir, modelName)
  const doDownload = download || downloadFileWithRetries
  const urls = entry.urls

  if (fs.existsSync(modelPath)) {
    const res = await verifyModelFileOnce(modelPath, entry)
    if (res.ok) {
      console.log(`[download] ${modelName}: cached copy verified, skipping download`)
      return [modelName, dir]
    }
    console.log(
      `[download] ${modelName}: cached copy failed integrity (${res.reason}); deleting and re-downloading`
    )
    try {
      fs.unlinkSync(modelPath)
    } catch (_) {}
  }

  // Pre-staged path (Android): copy the host-staged model from the read-only
  // staging dir into the normal (writable) modelDir, then return. The copy is a
  // fast local operation (no network). Returning a writable dir matters —
  // load() writes sibling files next to the model (e.g. openclCacheDir).
  const staged = prestagedModelDir(modelName)
  if (staged) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[prestage] Using pre-staged model ${modelName} (copying into writable modelDir)`)
    await copyPrestagedModel({ stagedDir: staged, modelName, modelPath, entry })
    return [modelName, dir]
  }

  fs.mkdirSync(dir, { recursive: true })
  console.log(`[download] Downloading test model: ${modelName}...`)
  _downloadCount++

  await doDownload(urls, modelPath)

  const res = await verifyModelFileOnce(modelPath, entry)
  if (!res.ok) {
    try {
      fs.unlinkSync(modelPath)
    } catch (_) {}
    throw new Error(
      `[download] ${modelName}: freshly downloaded file failed integrity: ${res.reason}`
    )
  }

  const stat = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)

  return [modelName, dir]
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
  const [, modelDir] = await ensureModel({ modelName })
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

  const GGMLBert = getGGMLBert()
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
  loadManifest,
  resolveModelEntry,
  verifyModelFile,
  verifyModelFileOnce,
  sha256File,
  resetVerificationCache,
  copyPrestagedModel,
  getDownloadCount,
  resetDownloadCount,
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
