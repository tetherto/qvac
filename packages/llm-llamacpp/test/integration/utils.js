'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const process = require('bare-process')
const crypto = require('bare-crypto')

const TRANSIENT_ERROR_CODES = new Set([
  // DNS / name resolution
  'EAI_NODATA',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ENOTFOUND',
  // connectivity — these dominate mobile Device Farm flakiness: a transient
  // network drop surfaces as ENETUNREACH/EHOSTUNREACH and MUST be retried
  // (previously these were treated as fatal, so a sub-second blip failed the
  // whole run with no retry).
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  // mid-transfer / timeout
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ESIZE',
  // post-transfer: the request "resolved" but the .part is missing/short or
  // couldn't be finalized (truncated/interrupted transfer) — retry it instead
  // of hard-failing on the resulting ENOENT/short file.
  'EINCOMPLETE'
])

const cleanedIntegrationCacheFiles = new Set()

function cleanupIntegrationCacheFiles(...cachePaths) {
  for (const cachePath of cachePaths.flat()) {
    if (!cachePath || cleanedIntegrationCacheFiles.has(cachePath)) continue
    if (!path.isAbsolute(cachePath)) {
      throw new Error(`integration cache cleanup requires an absolute path: ${cachePath}`)
    }

    cleanedIntegrationCacheFiles.add(cachePath)
    try {
      fs.unlinkSync(cachePath)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
}

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
    let settled = false
    let handedOff = false

    const safeResolve = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const safeReject = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const cleanupAndReject = (err) => {
      if (settled || handedOff) {
        if (!settled) safeReject(err)
        return
      }
      fs.unlink(dest, () => safeReject(err))
    }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      cleanupAndReject(err)
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
          handedOff = true
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
        cleanupAndReject(err)
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
        cleanupAndReject(err)
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
      cleanupAndReject(err)
    })
    req.end()
  })
}

async function downloadFileWithRetries(urls, dest, opts = {}) {
  // Defaults tuned for mobile Device Farm: connectivity gaps here can last tens
  // of seconds, so 4 attempts over ~7s gave up far too early. 7 attempts with a
  // backoff cap of 20s spans a ~1-2 min window, riding out real blips. Each
  // attempt is bounded by downloadFileOnce's own connect/idle timers (which
  // reset on data), so a slow-but-progressing large download is allowed to run
  // to completion rather than being capped by a fixed per-attempt deadline.
  const { retries = 6, minBytes = 1, backoffCapMs = 20_000, ...downloadOpts } = opts
  const urlList = Array.isArray(urls) ? urls : [urls]
  const partPath = dest + '.part'

  // Drop any leftover .part from a previously interrupted/killed run so a stale
  // temp file can't be mistaken for this download's output.
  try {
    fs.unlinkSync(partPath)
  } catch (_) {}

  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = urlList[attempt % urlList.length]
    const host = urlHost(url)
    try {
      await downloadFileOnce(url, partPath, downloadOpts)

      // Verify the artifact actually landed and is non-trivial. A "resolved"
      // download whose .part is missing or short means the transfer was
      // truncated/interrupted — surface it as EINCOMPLETE so the loop RETRIES
      // instead of hard-failing on a fatal ENOENT (which previously killed the
      // run after a single attempt).
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

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, backoffCapMs)
      console.log(
        `[download] Attempt ${attempt + 1}/${retries + 1} failed (${err.code || err.statusCode}) from ${host}, retrying in ${Math.round(delay)}ms...`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

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

// Android Device Farm pre-staging: the device's network to huggingface.co is
// unreliable (~40% of downloads fail even with retries), but the Device Farm
// HOST has solid network. The test-spec pre_test phase downloads each model on
// the host and `adb push`es it here; when a model is already staged we skip the
// on-device download entirely.
//
// /data/local/tmp is the one location that is both adb-writable from the host
// AND readable by the app process (proven on these devices: the harness already
// pushes testFilter.txt here and the app reads it). The app's own scoped dirs
// (/data/data/<pkg>, /sdcard/Android/data/<pkg>) reject adb access on Android
// 11+, so they cannot be used for host pre-staging.
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

// The standalone default modelDir assignment is patched by the mobile test
// packager to point at a writable app directory. Keep this shape stable.
async function ensureModel({ modelName, modelDir: modelDirOverride, manifest, download } = {}) {
  const modelDir = path.resolve(__dirname, '../model')
  const dir = modelDirOverride || modelDir
  const modelPath = path.join(dir, modelName)

  // Model URL + sha256/bytes come exclusively from models.manifest.json (by
  // modelName). The manifest is also the cache key for
  // .github/actions/cache-models. `modelDir`, `manifest`, and `download`
  // overrides exist for unit testing, but still require a fully pinned entry.
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

  // Pre-staged path: copy the host-staged model from the read-only staging dir
  // into the normal (app-private, WRITABLE) modelDir, then return modelDir. The
  // copy is a fast local operation (no network). Returning a writable dir is
  // essential — tests write sibling files next to the model (sliding-context
  // caches, finetuning checkpoints via path.join(modelDir, ...)), which would
  // fail if we returned the read-only /data/local/tmp staging dir directly.
  const staged = prestagedModelDir(modelName)
  if (staged) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[prestage] Using pre-staged model ${modelName} (copying into writable modelDir)`)
    await copyPrestagedModel({ stagedDir: staged, modelName, modelPath, entry })
    return [modelName, dir]
  }

  fs.mkdirSync(dir, { recursive: true })
  console.log(`[download] Downloading test model ${modelName}...`)
  _downloadCount++

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

  const stat = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)
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

/**
 * Get path to a media file - works on both desktop and mobile
 * On mobile, media files must be in testAssets/
 * On desktop, media files are in addon root /media/
 *
 * @param {string} filename - Name of the media file (e.g., 'elephant.jpg')
 * @returns {string} - Full path to the media file
 *
 * @example
 * const imagePath = getMediaPath('elephant.jpg')
 * const imageBytes = fs.readFileSync(imagePath)
 */
function getMediaPath(filename) {
  // Mobile environment - use asset loading from testAssets
  const isMobile = os.platform() === 'ios' || os.platform() === 'android'
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    // Asset not found in manifest
    throw new Error(
      `Asset not found in testAssets: ${filename}. Make sure ${filename} is in testAssets/ directory and rebuild the app.`
    )
  }

  // Desktop environment - use media directory at addon root
  return path.resolve(__dirname, '../../media', filename)
}

/**
 * Factory to create a shared onOutput handler and expose collected state.
 * Used in tests to capture and track LLM output events.
 *
 * @param {object} t - Test instance
 * @param {object} [logger=console] - Logger instance with a `log` method
 * @returns {{
 *   onOutput: (addon: object, event: string, jobId: string, output: string, error: string) => void,
 *   outputText: Object<string, string>,
 *   generatedText: string,
 *   jobCompleted: boolean,
 *   timeToFirstToken: number | null,
 *   stats: object | null,
 *   setStartTime: (time: number) => void
 * }} An object containing:
 *   - `onOutput` - Callback to handle addon output events ('Output', 'Error', 'JobEnded')
 *   - `outputText` - Map of jobId to accumulated output text
 *   - `generatedText` - All generated text concatenated
 *   - `jobCompleted` - Flag indicating if the job has finished
 *   - `timeToFirstToken` - Time to first token in milliseconds
 *   - `stats` - Stats object from the job
 *   - `setStartTime` - Function to set the start time for timeToFirstToken calculation
 *
 * @example
 * const collector = makeOutputCollector(t)
 * addon.setOnOutputCb(collector.onOutput)
 * // ... run inference ...
 * console.log(collector.generatedText)
 */
function makeOutputCollector(t, logger = console) {
  const outputText = {}
  let jobCompleted = false
  let generatedText = ''
  let timeToFirstToken = null
  let startTime = null
  let stats = null

  function onOutput(addon, event, jobId, output, error) {
    if (event === 'Output') {
      if (!outputText[jobId]) {
        outputText[jobId] = ''
        // Record time to first token (manual fallback)
        if (startTime && timeToFirstToken === null) {
          timeToFirstToken = Date.now() - startTime
        }
      }
      outputText[jobId] += output
      generatedText += output
    } else if (event === 'Error') {
      t.fail(`Job ${jobId} error: ${error}`)
    } else if (event === 'JobEnded') {
      // Capture stats from the data parameter (output is actually the data/stats object in JobEnded)
      stats = output
      logger.log(`Job ${jobId} completed. Output: "${outputText[jobId]}"`)
      if (stats) {
        logger.log(`Job ${jobId} stats: ${JSON.stringify(stats)}`)
      }
      jobCompleted = true
    }
  }

  return {
    onOutput,
    outputText,
    get generatedText() {
      return generatedText
    },
    get jobCompleted() {
      return jobCompleted
    },
    get timeToFirstToken() {
      return timeToFirstToken
    },
    get stats() {
      return stats
    },
    setStartTime(time) {
      startTime = time
    }
  }
}

function getDefaultTextModel() {
  return {
    modelName: process.env.TEXT_MODEL_NAME || 'small-test-model.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf'
  }
}

function getFinetuneModel() {
  // Use Qwen3_0.6B.Q8_0.gguf for finetuning tests (same as examples)
  // If model exists locally, use it; otherwise use small test model as fallback
  const modelDir = path.resolve(__dirname, '../../models')
  const qwenModelPath = path.join(modelDir, 'Qwen3_0.6B.Q8_0.gguf')

  if (fs.existsSync(qwenModelPath)) {
    return {
      modelName: 'Qwen3_0.6B.Q8_0.gguf',
      modelDir,
      useLocal: true
    }
  }

  // Fallback to small test model if Qwen not available
  return {
    modelName: process.env.TEXT_MODEL_NAME || 'small-test-model.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf',
    useLocal: false
  }
}

function createDefaultGpuConfig(overrides = {}) {
  return {
    gpu_layers: '99',
    ctx_size: '2048',
    device: 'gpu',
    ...overrides
  }
}

function createTestAddon(binding, modelPath, projectionPath, config, onOutput) {
  const { LlamaInterface } = require('../../addon.js')
  return new LlamaInterface(
    binding,
    {
      path: modelPath,
      projectionPath,
      config
    },
    onOutput
  )
}

async function waitForJobCompletion(addon, collector, options = {}) {
  const { checkComplete } = options
  const maxWaitSeconds = options.maxWaitSeconds || 600
  const pollIntervalMs = options.pollIntervalMs || 500

  for (let i = 0; i < maxWaitSeconds * (1000 / pollIntervalMs); i++) {
    if (checkComplete) {
      if (checkComplete(null, collector)) {
        return
      }
    } else {
      if (collector.jobCompleted) {
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error('Timeout waiting for job completion')
}

function createTestDataset(filePath, format = 'chat') {
  if (format === 'chat') {
    // Create a minimal chat-format JSONL dataset
    const samples = [
      {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '2+2 equals 4.' }
        ]
      },
      {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is the capital of France?' },
          { role: 'assistant', content: 'The capital of France is Paris.' }
        ]
      },
      {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello, how are you?' },
          { role: 'assistant', content: 'Hello! I am doing well, thank you for asking.' }
        ]
      }
    ]

    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const content = samples.map((s) => JSON.stringify(s)).join('\n')
    fs.writeFileSync(filePath, content)
  } else {
    // For tokenized format, we'd need actual tokenized data
    // For now, just create a simple text file
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      filePath,
      'This is a test dataset for finetuning.\nIt contains some sample text for training.'
    )
  }
  return filePath
}

function createPauseResumeTestDataset(filePath, count = 8) {
  const baseSamples = [
    {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '2+2 equals 4.' }
      ]
    },
    {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'The capital of France is Paris.' }
      ]
    },
    {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, how are you?' },
        { role: 'assistant', content: 'Hello! I am doing well, thank you for asking.' }
      ]
    },
    {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What color is the sky?' },
        { role: 'assistant', content: 'The sky is typically blue on a clear day.' }
      ]
    }
  ]
  const samples = []
  for (let i = 0; i < count; i++) {
    samples.push(baseSamples[i % baseSamples.length])
  }
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const content = samples.map((s) => JSON.stringify(s)).join('\n')
  fs.writeFileSync(filePath, content + '\n')
  return filePath
}

function setupParams(modelDir, overrides = {}) {
  const { testId = 'pause-resume', datasetSize, ...finetuneOverrides } = overrides
  const trainDatasetPath = path.join(modelDir, `train_${testId}.jsonl`)
  const checkpointDir = path.join(modelDir, `test_${testId}`)
  createPauseResumeTestDataset(trainDatasetPath, datasetSize)
  cleanupCheckpoints(checkpointDir)

  return {
    trainDatasetDir: trainDatasetPath,
    outputParametersDir: path.resolve(modelDir, 'finetune-output'),
    learningRate: 1e-5,
    lrMin: 1e-8,
    loraModules: 'attn_q,attn_k,attn_v,attn_o',
    assistantLossOnly: true,
    checkpointSaveSteps: 5,
    checkpointSaveDir: checkpointDir,
    validation: { type: 'split', fraction: 0.25 },
    ...finetuneOverrides
  }
}

function cleanupCheckpoints(checkpointDir) {
  if (fs.existsSync(checkpointDir)) {
    try {
      fs.rmSync(checkpointDir, { recursive: true, force: true })
    } catch (err) {}
  }
}

function verifyCheckpointExists(checkpointPath) {
  return fs.existsSync(checkpointPath) && fs.statSync(checkpointPath).isDirectory()
}

function findPauseCheckpoint(checkpointDir) {
  if (!fs.existsSync(checkpointDir)) {
    return null
  }

  const files = fs.readdirSync(checkpointDir)
  const pauseCheckpoints = files.filter((f) => f.startsWith('pause_checkpoint_step_'))

  if (pauseCheckpoints.length === 0) {
    return null
  }

  pauseCheckpoints.sort((a, b) => {
    const stepA = parseInt(a.match(/pause_checkpoint_step_(\d+)/)?.[1] || '0')
    const stepB = parseInt(b.match(/pause_checkpoint_step_(\d+)/)?.[1] || '0')
    return stepB - stepA
  })

  return path.join(checkpointDir, pauseCheckpoints[0])
}

function setupFinetuneTestData(testDataDir, testCheckpointDir, testId) {
  const trainDatasetPath = path.join(testDataDir, `train_${testId}.jsonl`)
  const evalDatasetPath = path.join(testDataDir, `eval_${testId}.jsonl`)
  const checkpointDir = path.join(testCheckpointDir, `test_${testId}`)

  createTestDataset(trainDatasetPath, 'chat')
  createTestDataset(evalDatasetPath, 'chat')
  cleanupCheckpoints(checkpointDir)

  return { trainDatasetPath, evalDatasetPath, checkpointDir }
}

function parsePauseCheckpointMetadata(pauseCheckpointPath) {
  const metadataPath = path.join(pauseCheckpointPath, 'metadata.txt')
  if (!fs.existsSync(metadataPath)) {
    return null
  }
  const content = fs.readFileSync(metadataPath, 'utf8')
  const meta = {}
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      meta[key] = value
    }
  }
  return {
    epoch: meta.epoch != null ? parseInt(meta.epoch, 10) : undefined,
    global_step: meta.global_step != null ? parseInt(meta.global_step, 10) : undefined
  }
}

function verifyPauseCheckpoint(t, checkpointDir) {
  const pauseCheckpointPath = findPauseCheckpoint(checkpointDir)

  if (!pauseCheckpointPath) {
    t.fail('Pause checkpoint must exist after pause - required for resume')
    return null
  }

  t.ok(verifyCheckpointExists(pauseCheckpointPath), 'Pause checkpoint should exist')
  t.comment(`Pause checkpoint found: ${path.basename(pauseCheckpointPath)}`)

  const metadataPath = path.join(pauseCheckpointPath, 'metadata.txt')
  t.ok(fs.existsSync(metadataPath), 'Pause checkpoint must contain metadata.txt')
  if (fs.existsSync(metadataPath)) {
    const metadataContent = fs.readFileSync(metadataPath, 'utf8')
    t.ok(metadataContent.length > 0, 'Metadata should not be empty')
  }

  const modelPath = path.join(pauseCheckpointPath, 'model.gguf')
  t.ok(fs.existsSync(modelPath), 'Pause checkpoint must contain model.gguf (LoRA adapter)')
  const optimizerPath = path.join(pauseCheckpointPath, 'optimizer.gguf')
  t.ok(
    fs.existsSync(optimizerPath),
    'Pause checkpoint must contain optimizer.gguf (optimizer state)'
  )

  return pauseCheckpointPath
}

async function handleEarlyCompletion(
  t,
  finetuneHandle,
  checkpointDir = null,
  message = 'Finetuning completed too quickly'
) {
  t.comment(`${message} - this is acceptable for small datasets`)
  const result = await (finetuneHandle?.await ? finetuneHandle.await() : finetuneHandle)
  t.ok(result && typeof result === 'object', 'Finetuning should complete with result object')
  if (checkpointDir) {
    cleanupCheckpoints(checkpointDir)
  }
  return result
}

async function verifyFinalStatus(t, model, result = null) {
  t.ok(result, 'Result must be provided')
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
  cleanupIntegrationCacheFiles,
  ensureModel,
  ensureModelPath,
  loadManifest,
  resolveModelEntry,
  verifyModelFile,
  verifyModelFileOnce,
  sha256File,
  resetVerificationCache,
  copyPrestagedModel,
  getDownloadCount,
  resetDownloadCount,
  getMediaPath,
  makeOutputCollector,
  getDefaultTextModel,
  getFinetuneModel,
  createDefaultGpuConfig,
  createTestAddon,
  waitForJobCompletion,
  createTestDataset,
  cleanupCheckpoints,
  verifyCheckpointExists,
  findPauseCheckpoint,
  parsePauseCheckpointMetadata,
  setupFinetuneTestData,
  setupParams,
  verifyPauseCheckpoint,
  handleEarlyCompletion,
  verifyFinalStatus,
  safeTest,
  downloadFileWithRetries
}
