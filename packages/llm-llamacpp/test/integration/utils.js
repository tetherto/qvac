'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const process = require('bare-process')

const TRANSIENT_ERROR_CODES = new Set([
  // DNS / name resolution
  'EAI_NODATA', 'EAI_AGAIN', 'EAI_FAIL', 'ENOTFOUND',
  // connectivity — these dominate mobile Device Farm flakiness: a transient
  // network drop surfaces as ENETUNREACH/EHOSTUNREACH and MUST be retried
  // (previously these were treated as fatal, so a sub-second blip failed the
  // whole run with no retry).
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED',
  // mid-transfer / timeout
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ESIZE',
  // post-transfer: the request "resolved" but the .part is missing/short or
  // couldn't be finalized (truncated/interrupted transfer) — retry it instead
  // of hard-failing on the resulting ENOENT/short file.
  'EINCOMPLETE'
])

const cleanedIntegrationCacheFiles = new Set()

function cleanupIntegrationCacheFiles (...cachePaths) {
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

function isTransientError (err) {
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) return true
  if (err.statusCode) {
    const s = err.statusCode
    return s === 408 || s === 429 || s >= 500
  }
  return false
}

function urlHost (url) {
  try { return new URL(url).host } catch (_) { return url }
}

async function downloadFileOnce (url, dest, opts = {}) {
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
      req.destroy(Object.assign(new Error(`Request timeout after ${timeoutMs}ms from ${urlHost(url)}`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)

    const req = https.request(url, response => {
      clearTimeout(reqTimer)

      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        if (_redirectCount >= maxRedirects) {
          fs.unlink(dest, () => safeReject(new Error(`Too many redirects (max ${maxRedirects}) from ${urlHost(url)}`)))
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
          response.destroy(Object.assign(
            new Error(`Response idle timeout after ${idleTimeoutMs}ms from ${urlHost(url)}`),
            { code: 'ETIMEDOUT' }
          ))
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
      file.on('close', () => { if (idleTimer) clearTimeout(idleTimer); safeResolve() })
    })

    req.on('error', err => { clearTimeout(reqTimer); file.destroy(); cleanupAndReject(err) })
    req.end()
  })
}

async function downloadFileWithRetries (urls, dest, opts = {}) {
  // Defaults tuned for mobile Device Farm: connectivity gaps here can last tens
  // of seconds, so 4 attempts over ~7s gave up far too early. 7 attempts with a
  // backoff cap of 20s spans a ~1-2 min window, riding out real blips. Each
  // attempt is bounded by downloadFileOnce's own connect/idle timers (which
  // reset on data), so a slow-but-progressing large download is allowed to run
  // to completion rather than being capped by a fixed per-attempt deadline.
  const {
    retries = 6,
    minBytes = 1,
    backoffCapMs = 20_000,
    ...downloadOpts
  } = opts
  const urlList = Array.isArray(urls) ? urls : [urls]
  const partPath = dest + '.part'

  // Drop any leftover .part from a previously interrupted/killed run so a stale
  // temp file can't be mistaken for this download's output.
  try { fs.unlinkSync(partPath) } catch (_) {}

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
      try { size = fs.statSync(partPath).size } catch (_) { size = -1 }
      if (size < minBytes) {
        throw Object.assign(
          new Error(`Incomplete download from ${host} (${size < 0 ? 'missing .part' : size + ' bytes'})`),
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
      try { fs.unlinkSync(partPath) } catch (_) {}

      const attemptsLeft = retries - attempt
      if (!isTransientError(err) || attemptsLeft === 0) {
        console.error(`[download] Failed after ${attempt + 1} attempt(s) from ${host}: ${err.code || err.message}`)
        throw err
      }

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, backoffCapMs)
      console.log(`[download] Attempt ${attempt + 1}/${retries + 1} failed (${err.code || err.statusCode}) from ${host}, retrying in ${Math.round(delay)}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
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

function prestagedModelDir (modelName) {
  if (os.platform() !== 'android') return null
  try {
    const p = path.join(PRESTAGED_MODEL_DIR, modelName)
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return PRESTAGED_MODEL_DIR
  } catch (_) {}
  return null
}

async function ensureModel ({ modelName, downloadUrl }) {
  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath)
    if (stat.size > 0) {
      return [modelName, modelDir]
    }
    console.log(`[download] Removing zero-byte cached file: ${modelName}`)
    fs.unlinkSync(modelPath)
  }

  // Pre-staged path: copy the host-staged model from the read-only staging dir
  // into the normal (app-private, WRITABLE) modelDir, then return modelDir. The
  // copy is a fast local operation (no network). Returning a writable dir is
  // essential — tests write sibling files next to the model (sliding-context
  // caches, finetuning checkpoints via path.join(modelDir, ...)), which would
  // fail if we returned the read-only /data/local/tmp staging dir directly.
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
  console.log(`[download] Downloading test model ${modelName}...`)

  await downloadFileWithRetries(downloadUrl, modelPath)

  const stat = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)
  return [modelName, modelDir]
}

async function ensureModelPath ({ modelName, downloadUrl }) {
  const [downloadedModelName, modelDir] = await ensureModel({ modelName, downloadUrl })
  return path.join(modelDir, downloadedModelName)
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
function getMediaPath (filename) {
  // Mobile environment - use asset loading from testAssets
  const isMobile = os.platform() === 'ios' || os.platform() === 'android'
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    // Asset not found in manifest
    throw new Error(`Asset not found in testAssets: ${filename}. Make sure ${filename} is in testAssets/ directory and rebuild the app.`)
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
function makeOutputCollector (t, logger = console) {
  const outputText = {}
  let jobCompleted = false
  let generatedText = ''
  let timeToFirstToken = null
  let startTime = null
  let stats = null

  function onOutput (addon, event, jobId, output, error) {
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
    get generatedText () { return generatedText },
    get jobCompleted () { return jobCompleted },
    get timeToFirstToken () { return timeToFirstToken },
    get stats () { return stats },
    setStartTime (time) { startTime = time }
  }
}

function getDefaultTextModel () {
  return {
    modelName: process.env.TEXT_MODEL_NAME || 'small-test-model.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf'
  }
}

function getFinetuneModel () {
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

function createDefaultGpuConfig (overrides = {}) {
  return {
    gpu_layers: '99',
    ctx_size: '2048',
    device: 'gpu',
    ...overrides
  }
}

function createTestAddon (binding, modelPath, projectionPath, config, onOutput) {
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

async function waitForJobCompletion (addon, collector, options = {}) {
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
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error('Timeout waiting for job completion')
}

function createTestDataset (filePath, format = 'chat') {
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
    const content = samples.map(s => JSON.stringify(s)).join('\n')
    fs.writeFileSync(filePath, content)
  } else {
    // For tokenized format, we'd need actual tokenized data
    // For now, just create a simple text file
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, 'This is a test dataset for finetuning.\nIt contains some sample text for training.')
  }
  return filePath
}

function createPauseResumeTestDataset (filePath, count = 8) {
  const baseSamples = [
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is 2+2?' }, { role: 'assistant', content: '2+2 equals 4.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is the capital of France?' }, { role: 'assistant', content: 'The capital of France is Paris.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Hello, how are you?' }, { role: 'assistant', content: 'Hello! I am doing well, thank you for asking.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What color is the sky?' }, { role: 'assistant', content: 'The sky is typically blue on a clear day.' }] }
  ]
  const samples = []
  for (let i = 0; i < count; i++) {
    samples.push(baseSamples[i % baseSamples.length])
  }
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const content = samples.map(s => JSON.stringify(s)).join('\n')
  fs.writeFileSync(filePath, content + '\n')
  return filePath
}

function setupParams (modelDir, overrides = {}) {
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

function cleanupCheckpoints (checkpointDir) {
  if (fs.existsSync(checkpointDir)) {
    try {
      fs.rmSync(checkpointDir, { recursive: true, force: true })
    } catch (err) {}
  }
}

function verifyCheckpointExists (checkpointPath) {
  return fs.existsSync(checkpointPath) && fs.statSync(checkpointPath).isDirectory()
}

function findPauseCheckpoint (checkpointDir) {
  if (!fs.existsSync(checkpointDir)) {
    return null
  }

  const files = fs.readdirSync(checkpointDir)
  const pauseCheckpoints = files.filter(f => f.startsWith('pause_checkpoint_step_'))

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

function setupFinetuneTestData (testDataDir, testCheckpointDir, testId) {
  const trainDatasetPath = path.join(testDataDir, `train_${testId}.jsonl`)
  const evalDatasetPath = path.join(testDataDir, `eval_${testId}.jsonl`)
  const checkpointDir = path.join(testCheckpointDir, `test_${testId}`)

  createTestDataset(trainDatasetPath, 'chat')
  createTestDataset(evalDatasetPath, 'chat')
  cleanupCheckpoints(checkpointDir)

  return { trainDatasetPath, evalDatasetPath, checkpointDir }
}

function parsePauseCheckpointMetadata (pauseCheckpointPath) {
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

function verifyPauseCheckpoint (t, checkpointDir) {
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
  t.ok(fs.existsSync(optimizerPath), 'Pause checkpoint must contain optimizer.gguf (optimizer state)')

  return pauseCheckpointPath
}

async function handleEarlyCompletion (t, finetuneHandle, checkpointDir = null, message = 'Finetuning completed too quickly') {
  t.comment(`${message} - this is acceptable for small datasets`)
  const result = await (finetuneHandle?.await ? finetuneHandle.await() : finetuneHandle)
  t.ok(result && typeof result === 'object', 'Finetuning should complete with result object')
  if (checkpointDir) {
    cleanupCheckpoints(checkpointDir)
  }
  return result
}

async function verifyFinalStatus (t, model, result = null) {
  t.ok(result, 'Result must be provided')
}

const test = require('brittle')

function safeTest (name, opts, fn) {
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
