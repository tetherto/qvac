'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const FilesystemDL = require('@qvac/dl-filesystem')

async function downloadFile (url, dest) {
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

    const req = https.request(url, response => {
      // Handle redirects (added 307, 308 for Windows model download)
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        // Wait for unlink to complete before recursive call (fixes Windows race condition)
        fs.unlink(dest, (unlinkErr) => {
          // Ignore ENOENT - file may not exist yet
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            return safeReject(unlinkErr)
          }

          let redirectUrl = response.headers.location
          // Handle relative redirects
          if (redirectUrl.startsWith('/')) {
            const originalUrl = new URL(url)
            redirectUrl = `${originalUrl.protocol}//${originalUrl.host}${redirectUrl}`
          }

          downloadFile(redirectUrl, dest)
            .then(safeResolve)
            .catch(safeReject)
        })
        return
      }

      if (response.statusCode !== 200) {
        file.destroy()
        fs.unlink(dest, () => safeReject(new Error(`Download failed: HTTP ${response.statusCode} from ${url}`)))
        return
      }

      response.on('error', (err) => {
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
      })

      response.pipe(file)

      // Wait for 'close' event to ensure data is fully flushed to disk (important on Windows)
      file.on('close', () => {
        safeResolve()
      })
    })

    req.on('error', err => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    req.end()
  })
}

async function ensureModel ({ modelName, downloadUrl }) {
  const modelDir = path.resolve(__dirname, '../model')

  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    return [modelName, modelDir]
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`Downloading test model ${modelName}...`)

  await downloadFile(downloadUrl, modelPath)

  const stats = fs.statSync(modelPath)
  console.log(`Model ready: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
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

function createTestAddon (binding, modelPath, projectionPath, config, onOutput, transitionCb = null) {
  const { LlamaInterface } = require('../../addon.js')
  return new LlamaInterface(
    binding,
    {
      path: modelPath,
      projectionPath,
      config
    },
    onOutput,
    transitionCb
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

function createPauseResumeTestDataset (filePath) {
  const baseSamples = [
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is 2+2?' }, { role: 'assistant', content: '2+2 equals 4.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is the capital of France?' }, { role: 'assistant', content: 'The capital of France is Paris.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Hello, how are you?' }, { role: 'assistant', content: 'Hello! I am doing well, thank you for asking.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What color is the sky?' }, { role: 'assistant', content: 'The sky is typically blue on a clear day.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Name a planet.' }, { role: 'assistant', content: 'Earth is a planet in our solar system.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is 3 times 4?' }, { role: 'assistant', content: '3 times 4 equals 12.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is the opposite of hot?' }, { role: 'assistant', content: 'The opposite of hot is cold.' }] },
    { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'How many days in a week?' }, { role: 'assistant', content: 'There are 7 days in a week.' }] }
  ]
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const content = baseSamples.map(s => JSON.stringify(s)).join('\n')
  fs.writeFileSync(filePath, content)
  return filePath
}

function setupPauseResumeTestData (testDataDir, testCheckpointDir, testId) {
  const trainDatasetPath = path.join(testDataDir, `train${testId}.jsonl`)
  const evalDatasetPath = path.join(testDataDir, `eval${testId}.jsonl`)
  const checkpointDir = path.join(testCheckpointDir, `test${testId}`)

  createPauseResumeTestDataset(trainDatasetPath)
  createPauseResumeTestDataset(evalDatasetPath)
  cleanupCheckpoints(checkpointDir)

  return { trainDatasetPath, evalDatasetPath, checkpointDir }
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

function getDefaultFinetuneConfig (overrides = {}) {
  const testOutputDir = path.join('test', 'finetune-output')
  return {
    trainDatasetDir: '',
    evalDatasetDir: '',
    outputParametersDir: testOutputDir,
    numberOfEpochs: 1,
    learningRate: 1e-5,
    lrMin: 1e-8,
    lrScheduler: 'cosine',
    warmupRatio: 0.1,
    contextLength: 128,
    batchSize: 4,
    microBatchSize: 4,
    loraModules: 'attn_q,attn_k,attn_v,attn_o',
    assistantLossOnly: true,
    checkpointSaveSteps: 5,
    ...overrides
  }
}

async function waitForFinetuningStart (model, options = {}) {
  const maxAttempts = options.maxAttempts || 10
  const pollIntervalMs = options.pollIntervalMs || 100

  let attempts = 0
  while (attempts < maxAttempts) {
    const running = model.addon?.isFinetuningRunning?.()
    if (running) return 'FINETUNING'
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    attempts++
  }
  return 'IDLE'
}

function setupFinetuneTestData (testDataDir, testCheckpointDir, testId) {
  const trainDatasetPath = path.join(testDataDir, `train${testId}.jsonl`)
  const evalDatasetPath = path.join(testDataDir, `eval${testId}.jsonl`)
  const checkpointDir = path.join(testCheckpointDir, `test${testId}`)

  createTestDataset(trainDatasetPath, 'chat')
  createTestDataset(evalDatasetPath, 'chat')
  cleanupCheckpoints(checkpointDir)

  return { trainDatasetPath, evalDatasetPath, checkpointDir }
}

function verifyPauseCheckpoint (t, checkpointDir, waitMs = 3000) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const pauseCheckpointPath = findPauseCheckpoint(checkpointDir)

      if (!pauseCheckpointPath) {
        t.fail('Pause checkpoint must exist after pause - required for resume')
        return resolve(null)
      }

      t.ok(verifyCheckpointExists(pauseCheckpointPath), 'Pause checkpoint should exist')
      t.comment(`Pause checkpoint found: ${path.basename(pauseCheckpointPath)}`)

      const metadataPath = path.join(pauseCheckpointPath, 'metadata.json')
      t.ok(fs.existsSync(metadataPath), 'Pause checkpoint must contain metadata.json')
      if (fs.existsSync(metadataPath)) {
        const metadataContent = fs.readFileSync(metadataPath, 'utf8')
        t.ok(metadataContent.length > 0, 'Metadata should not be empty')
      }

      const modelPath = path.join(pauseCheckpointPath, 'model.gguf')
      t.ok(fs.existsSync(modelPath), 'Pause checkpoint must contain model.gguf (LoRA adapter)')

      resolve(pauseCheckpointPath)
    }, waitMs)
  })
}

async function handleEarlyCompletion (t, finetunePromise, checkpointDir = null, message = 'Finetuning completed too quickly') {
  t.comment(`${message} - this is acceptable for small datasets`)
  const result = await finetunePromise
  t.ok(result && typeof result === 'object', 'Finetuning should complete with result object')
  t.ok(result?.status === 'IDLE', `Final status should be IDLE, got: ${result?.status}`)
  if (checkpointDir) {
    cleanupCheckpoints(checkpointDir)
  }
  return result
}

async function verifyFinalStatus (t, model, result = null) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  t.ok(result, 'Result must be provided')
  const finalStatus = result?.status ?? 'IDLE'
  t.ok(finalStatus === 'IDLE', `Final status should be IDLE, got: ${finalStatus}`)
  return finalStatus
}

module.exports = {
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
  getDefaultFinetuneConfig,
  waitForFinetuningStart,
  setupFinetuneTestData,
  setupPauseResumeTestData,
  verifyPauseCheckpoint,
  handleEarlyCompletion,
  verifyFinalStatus
}
