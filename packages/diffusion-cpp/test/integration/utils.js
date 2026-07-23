'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const crypto = require('bare-crypto')

// Lazily loaded: requiring addonLogging pulls in the native binding, which
// isn't needed for model download/integrity helpers and lets those run in
// unit tests without a compiled addon.
function getAddonLogging() {
  return require('../../addonLogging')
}

const ANDROID_GENERATED_IMAGE_ARTIFACT_DIRS = [
  '/sdcard/Download/qvac-generated-images',
  '/storage/emulated/0/Download/qvac-generated-images'
]

class GeneratedImageSaver {
  constructor(modelDir) {
    const platform = os.platform()

    try {
      if (platform === 'android') {
        for (const artifactDir of ANDROID_GENERATED_IMAGE_ARTIFACT_DIRS) {
          try {
            fs.mkdirSync(artifactDir, { recursive: true })
            this.artifactDir = artifactDir
            break
          } catch (_) {}
        }
        return
      }

      // Use a separate directory on iOS to avoid pulling the model file on device farm runs.
      this.artifactDir =
        platform === 'ios' ? path.resolve(modelDir, '../generated-images') : modelDir
      fs.mkdirSync(this.artifactDir, { recursive: true })
    } catch (err) {
      console.log(`Could not prepare artifact directory: ${err.message}`)
    }
  }

  save(filename, imageData) {
    if (!this.artifactDir) return

    const outputPath = path.join(this.artifactDir, filename)

    try {
      fs.writeFileSync(outputPath, imageData)
      console.log(`Image saved to ${outputPath}`)
    } catch (err) {
      console.log(`Could not save image to ${this.artifactDir}: ${err.message}`)
    }
  }
}

const TRANSIENT_ERROR_CODES = new Set([
  'EAI_NODATA',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ESIZE',
  // bare-https surfaces dropped connections with these names/codes instead of
  // the classic errno codes above; without them a recoverable socket drop
  // (e.g. "CONNECTION_LOST: Socket hung up") is treated as fatal and not retried.
  'CONNECTION_LOST',
  'ECONNREFUSED',
  'ECONNCLOSED'
])

// Fallback for transports (e.g. bare-https) that don't always set err.code:
// match on the human-readable message so connection resets / DNS blips retry.
const TRANSIENT_ERROR_MESSAGE =
  /socket hung up|connection (lost|abort|reset|closed|refused)|hung up|no address|network|timed? ?out|EAI_|ENOTFOUND|ECONNRESET|ECONNABORTED/i

function isTransientError(err) {
  if (!err) return false
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) return true
  if (err.name && TRANSIENT_ERROR_CODES.has(err.name)) return true
  if (err.statusCode === 408 || err.statusCode === 429) return true
  if (err.statusCode >= 500) return true
  if (err.message && TRANSIENT_ERROR_MESSAGE.test(err.message)) return true
  return false
}

function urlHost(url) {
  try {
    return new URL(url).host
  } catch (_) {
    return url
  }
}

async function downloadFileOnce(url, dest, opts) {
  opts = opts || {}
  const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 10
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 30000
  const idleTimeoutMs = opts.idleTimeoutMs != null ? opts.idleTimeoutMs : 30000

  return new Promise((resolve, reject) => {
    let settled = false
    let reqTimer = null
    let idleTimer = null

    function done(err) {
      if (settled) return
      settled = true
      clearTimeout(reqTimer)
      clearTimeout(idleTimer)
      if (err) reject(err)
      else resolve()
    }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      done(err)
    })

    function makeRequest(reqUrl, redirectsLeft) {
      const req = https.request(reqUrl, (response) => {
        clearTimeout(reqTimer)

        if ([301, 302, 307, 308].includes(response.statusCode)) {
          if (redirectsLeft <= 0) {
            file.destroy()
            return done(new Error(`Too many redirects downloading ${urlHost(reqUrl)}`))
          }
          const location = new URL(response.headers.location, reqUrl).href
          makeRequest(location, redirectsLeft - 1)
          return
        }

        if (response.statusCode !== 200) {
          file.destroy()
          const err = new Error(
            `Download failed: HTTP ${response.statusCode} from ${urlHost(reqUrl)}`
          )
          err.statusCode = response.statusCode
          return done(err)
        }

        function resetIdleTimer() {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            response.destroy(
              Object.assign(new Error(`Idle timeout downloading ${urlHost(reqUrl)}`), {
                code: 'ETIMEDOUT'
              })
            )
          }, idleTimeoutMs)
        }

        resetIdleTimer()

        response.on('data', () => resetIdleTimer())

        response.on('error', (err) => {
          file.destroy()
          done(err)
        })

        response.pipe(file)

        file.on('close', () => {
          clearTimeout(idleTimer)
          done(null)
        })
      })

      reqTimer = setTimeout(() => {
        req.destroy(
          Object.assign(new Error(`Request timeout downloading ${urlHost(reqUrl)}`), {
            code: 'ETIMEDOUT'
          })
        )
      }, timeoutMs)

      req.on('error', (err) => {
        clearTimeout(reqTimer)
        file.destroy()
        done(err)
      })

      req.end()
    }

    makeRequest(url, maxRedirects)
  })
}

async function downloadFileWithRetries(urls, dest, opts) {
  opts = opts || {}
  const retries = opts.retries != null ? opts.retries : 3
  const minBytes = opts.minBytes != null ? opts.minBytes : 1
  const urlList = Array.isArray(urls) ? urls : [urls]
  const partPath = dest + '.part'

  let lastErr = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    const url = urlList[attempt % urlList.length]

    try {
      await downloadFileOnce(url, partPath, opts)

      const stats = fs.statSync(partPath)
      if (stats.size < minBytes) {
        throw Object.assign(
          new Error(`Downloaded file too small: ${stats.size} bytes from ${urlHost(url)}`),
          { code: 'ESIZE' }
        )
      }

      fs.renameSync(partPath, dest)
      return
    } catch (err) {
      lastErr = err
      try {
        fs.unlinkSync(partPath)
      } catch (_) {}

      const attemptsLeft = retries - attempt
      if (attemptsLeft > 0 && isTransientError(err)) {
        console.log(
          `[download] Attempt ${attempt + 1} failed (${err.message}), retrying (${attemptsLeft} left)...`
        )
      } else {
        break
      }
    }
  }

  console.log(`[download] All attempts failed: ${lastErr && lastErr.message}`)
  throw lastErr
}

const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, 'models.manifest.json')
let _manifestCache

// Loads and caches the model manifest (single source of truth for model
// URLs + sha256/bytes integrity values). The default manifest is mandatory:
// a packaging or parsing error must not silently disable integrity checks.
//
// The default path is loaded via a literal require() rather than
// fs.readFileSync. Mobile builds pack this file into a single bundle via
// bare-pack, which resolves its module graph by statically following
// require()/import calls (bare-module-traverse) — a dynamic fs.readFileSync
// call is invisible to that resolution and silently drops the manifest from
// the bundle, so every model lookup fails on-device even though the file is
// present on disk at build time. require('./models.manifest.json') is a
// static reference bare-pack can see and embed.
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

// Avoid hashing the same multi-GB file repeatedly within one integration-test
// process. The key includes file identity, mutable stat fields, and the expected
// pins, so replacing or changing a file forces a new verification.
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

let _downloadCount = 0
function getDownloadCount() {
  return _downloadCount
}
function resetDownloadCount() {
  _downloadCount = 0
}

// Resolves a model into test/model/, reusing a cached copy when it passes
// integrity. Model URL + sha256/bytes come exclusively from
// models.manifest.json (by `modelName`). `modelDirOverride`, `manifest`, and
// `download` overrides exist for unit testing, but the override manifest must
// still contain a fully pinned entry.
//
// The line below resolving the default model directory is matched verbatim
// by qvac-test-addon-mobile's build-time patch (patchIntegrationUtilsForMobile),
// which rewrites it to a writable mobile directory (__dirname is a virtual
// bundle path on-device, not writable). Keep it intact and standalone, with
// no other occurrence of this exact snippet earlier in the file, so that
// patch's string replace (which only replaces the first match) keeps hitting
// the right line.
async function ensureModel({ modelName, modelDir: modelDirOverride, manifest, download } = {}) {
  const modelDir = path.resolve(__dirname, '../model')
  const dir = modelDirOverride || modelDir
  const modelPath = path.join(dir, modelName)
  const entry = resolveModelEntry(modelName, manifest !== undefined ? { manifest } : {})
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

  fs.mkdirSync(dir, { recursive: true })
  console.log(`[download] Downloading test model ${modelName}...`)
  _downloadCount++

  // Multi-GB model downloads on device-farm runners hit flaky CDN/network
  // (connection resets, DNS blips); give them extra retries so a single drop
  // doesn't fail the whole test.
  await doDownload(urls, modelPath, { retries: 6 })

  const res = await verifyModelFileOnce(modelPath, entry)
  if (!res.ok) {
    try {
      fs.unlinkSync(modelPath)
    } catch (_) {}
    throw new Error(
      `[download] ${modelName}: freshly downloaded file failed integrity: ${res.reason}`
    )
  }

  const stats = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
  return [modelName, dir]
}

async function ensureModelPath({ modelName, modelDir, manifest, download } = {}) {
  const [downloadedModelName, resolvedDir] = await ensureModel({
    modelName,
    modelDir,
    manifest,
    download
  })
  return path.join(resolvedDir, downloadedModelName)
}

// Repository-supported local model directories are cache locations, not trust
// boundaries. Exact filenames declared in the manifest must pass the same
// SHA-256/size checks as test/model before an integration test can use them.
async function verifyLocalModelPath({ modelName, filePath, manifest } = {}) {
  const entry = resolveModelEntry(modelName, manifest !== undefined ? { manifest } : {})
  const result = await verifyModelFileOnce(filePath, entry)
  if (!result.ok) {
    throw new Error(`[model] ${modelName}: local file failed integrity: ${result.reason}`)
  }
  return filePath
}

/**
 * Get path to a media file - works on both desktop and mobile
 * On mobile, media files must be in testAssets/
 * On desktop, media files are in addon root /media/
 */
function getMediaPath(filename) {
  const isMobile = os.platform() === 'ios' || os.platform() === 'android'
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    throw new Error(
      `Asset not found in testAssets: ${filename}. Make sure ${filename} is in testAssets/ directory and rebuild the app.`
    )
  }

  return path.resolve(__dirname, '../../media', filename)
}

/**
 * Factory to create a shared onOutput handler for image generation.
 */
function makeOutputCollector(t, logger = console) {
  const outputData = {}
  let jobCompleted = false
  let generatedData = null
  let stats = null

  function onOutput(addon, event, jobId, output, error) {
    if (event === 'Output') {
      if (!outputData[jobId]) {
        outputData[jobId] = []
      }
      outputData[jobId].push(output)
      generatedData = output
    } else if (event === 'Error') {
      t.fail(`Job ${jobId} error: ${error}`)
    } else if (event === 'JobEnded') {
      stats = output
      logger.log(`Job ${jobId} completed.`)
      if (stats) {
        logger.log(`Job ${jobId} stats: ${JSON.stringify(stats)}`)
      }
      jobCompleted = true
    }
  }

  return {
    onOutput,
    outputData,
    get generatedData() {
      return generatedData
    },
    get jobCompleted() {
      return jobCompleted
    },
    get stats() {
      return stats
    }
  }
}

function detectPlatform() {
  return `${os.platform()}-${os.arch()}`
}

function setupJsLogger(binding = getAddonLogging()) {
  const priorityNames = {
    0: 'ERROR',
    1: 'WARNING',
    2: 'INFO',
    3: 'DEBUG'
  }

  binding.setLogger((priority, message) => {
    const priorityName = priorityNames[priority] || `UNKNOWN(${priority})`
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [C++ TEST] [${priorityName}]: ${message}`)
  })
  return binding
}

function releaseJsLogger(binding = getAddonLogging()) {
  try {
    binding.releaseLogger()
  } catch (_) {}
}

function withIntegrationDefaults(args) {
  return {
    ...args,
    config: {
      ...(args.config || {}),
      verbosity: 2
    },
    opts: {
      ...(args.opts || {}),
      stats: true
    }
  }
}

function isPng(buf) {
  if (!buf || buf.length < 8) return false
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
}

const test = require('brittle')

function safeTest(name, opts, fn) {
  test(name, opts, async (t) => {
    setupJsLogger()
    try {
      await fn(t)
    } catch (err) {
      console.error(err)
      t.fail(`${name}: ${err.message}`)
    } finally {
      releaseJsLogger()
    }
  })
}

module.exports = {
  GeneratedImageSaver,
  ensureModel,
  ensureModelPath,
  verifyLocalModelPath,
  loadManifest,
  resolveModelEntry,
  verifyModelFile,
  verifyModelFileOnce,
  sha256File,
  resetVerificationCache,
  getDownloadCount,
  resetDownloadCount,
  getMediaPath,
  makeOutputCollector,
  detectPlatform,
  setupJsLogger,
  releaseJsLogger,
  withIntegrationDefaults,
  isPng,
  safeTest
}
