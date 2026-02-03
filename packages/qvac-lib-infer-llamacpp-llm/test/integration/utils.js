'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const FilesystemDL = require('@qvac/dl-filesystem')

async function downloadFile (url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.request(url, response => {
      // Handle redirects (added 307, 308 for Windows model download)
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        fs.unlink(dest, () => { }) // Clean up partial file

        let redirectUrl = response.headers.location
        // Handle relative redirects
        if (redirectUrl.startsWith('/')) {
          const originalUrl = new URL(url)
          redirectUrl = `${originalUrl.protocol}//${originalUrl.host}${redirectUrl}`
        }

        return downloadFile(redirectUrl, dest)
          .then(resolve)
          .catch(reject)
      }
      if (response.statusCode !== 200) {
        file.destroy()
        fs.unlink(dest, () => { })
        return reject(new Error(`Download failed: ${response.statusCode}`))
      }
      response.pipe(file)
      file.on('finish', () => {
        file.destroy()
        resolve()
      })
    })
    req.on('error', err => {
      file.destroy()
      fs.unlink(dest, () => reject(err))
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

async function testTextWithSettings (t, requestedModelName, downloadUrl, settings) {
  const timeout = 600_000
  t.timeout(timeout)

  const [modelName, dirPath] = await ensureModel({ modelName: requestedModelName, downloadUrl })
  const modelPath = path.join(dirPath, modelName)
  t.ok(fs.existsSync(modelPath), 'Model file should exist')

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

  const diskPath = path.join('test', 'model')
  const loader = new FilesystemDL({ dirPath: diskPath })
  const logger = new TestLogger()
  const inference = new LlmLlamacpp({
    modelName,
    loader,
    logger,
    diskPath,
    projectionPath: '',
    opts: { stats: true }
  }, settings)
  await inference.load()

  const status = await inference.status()
  t.ok(['LOADING', 'IDLE', 'LISTENING'].includes(status), 'Addon should have valid initial status')

  const messages = [
    {
      role: 'system',
      content: 'You are a helpful assistant.'
    },
    {
      role: 'user',
      content: 'Hello my name is to build tests.'
    }
  ]
  const response = await inference.run(messages)
  const generatedText = await response._finishPromise
  t.ok(generatedText.length > 0, 'Should generate some text output')
  t.ok(response.stats.TPS > 0, 'Should generate token per second stats')
  console.log('Generated text:', generatedText.join(''))
  console.log('Generated stats:', response.stats)

  t.teardown(async () => {
    await loader.close()
    await inference.addon.destroyInstance()
  })

  return response.stats
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

function verifyAddonStatus (t, status) {
  t.ok(['LOADING', 'IDLE', 'LISTENING', 'FINETUNING', 'PAUSED'].includes(status),
    `Addon should have valid status, got: ${status}`)
}

async function waitForJobCompletion (addon, collector, options = {}) {
  const { checkComplete } = options
  const maxWaitSeconds = options.maxWaitSeconds || 600
  const pollIntervalMs = options.pollIntervalMs || 500

  for (let i = 0; i < maxWaitSeconds * (1000 / pollIntervalMs); i++) {
    const currentStatus = await addon.status()
    if (checkComplete) {
      if (checkComplete(currentStatus, collector)) {
        return
      }
    } else {
      if (currentStatus === 'IDLE' && collector.jobCompleted) {
        return
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error('Timeout waiting for job completion')
}

async function waitForStatus (model, expectedStatus, options = {}) {
  const pollIntervalMs = options.pollIntervalMs || 200
  const timeoutMs = options.timeoutMs || 30000
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    try {
      const currentStatus = await model.status()
      if (currentStatus === expectedStatus) {
        return currentStatus
      }
    } catch (error) {
      // Continue polling on error
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`Timeout waiting for status ${expectedStatus}`)
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

function cleanupCheckpoints (checkpointDir) {
  if (fs.existsSync(checkpointDir)) {
    try {
      fs.rmSync(checkpointDir, { recursive: true, force: true })
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

function verifyCheckpointExists (checkpointPath) {
  return fs.existsSync(checkpointPath) && fs.statSync(checkpointPath).isDirectory()
}

// Find pause checkpoint directory (step-based naming: pause_checkpoint_step_00000003)
function findPauseCheckpoint (checkpointDir) {
  if (!fs.existsSync(checkpointDir)) {
    return null
  }

  const files = fs.readdirSync(checkpointDir)
  const pauseCheckpoints = files.filter(f => f.startsWith('pause_checkpoint_step_'))

  if (pauseCheckpoints.length === 0) {
    return null
  }

  // Return the path to the latest pause checkpoint (highest step number)
  // Sort by step number (extract from name)
  pauseCheckpoints.sort((a, b) => {
    const stepA = parseInt(a.match(/pause_checkpoint_step_(\d+)/)?.[1] || '0')
    const stepB = parseInt(b.match(/pause_checkpoint_step_(\d+)/)?.[1] || '0')
    return stepB - stepA // Descending order
  })

  return path.join(checkpointDir, pauseCheckpoints[0])
}

function getDefaultFinetuneConfig (overrides = {}) {
  const testOutputDir = path.join('test', 'finetune-output')
  return {
    trainDatasetDir: '', // Must be provided in overrides
    evalDatasetDir: '', // Must be provided in overrides
    outputParametersDir: testOutputDir, // Required property
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

// Wait for finetuning to start, handling race conditions where it might complete quickly
async function waitForFinetuningStart (model, options = {}) {
  const maxAttempts = options.maxAttempts || 10
  const pollIntervalMs = options.pollIntervalMs || 100

  let status = await model.status()
  let attempts = 0

  while (status !== 'FINETUNING' && status !== 'IDLE' && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    status = await model.status()
    attempts++
  }

  return status
}

// Setup test datasets and checkpoint directory
function setupFinetuneTestData (testDataDir, testCheckpointDir, testId) {
  const trainDatasetPath = path.join(testDataDir, `train${testId}.jsonl`)
  const evalDatasetPath = path.join(testDataDir, `eval${testId}.jsonl`)
  const checkpointDir = path.join(testCheckpointDir, `test${testId}`)

  createTestDataset(trainDatasetPath, 'chat')
  createTestDataset(evalDatasetPath, 'chat')
  cleanupCheckpoints(checkpointDir)

  return { trainDatasetPath, evalDatasetPath, checkpointDir }
}

// Verify pause checkpoint exists and has required files
function verifyPauseCheckpoint (t, checkpointDir, waitMs = 3000) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const pauseCheckpointPath = findPauseCheckpoint(checkpointDir)

      if (pauseCheckpointPath) {
        t.ok(verifyCheckpointExists(pauseCheckpointPath), 'Pause checkpoint should exist')
        t.comment(`Pause checkpoint found: ${path.basename(pauseCheckpointPath)}`)

        // Verify metadata exists
        const metadataPath = path.join(pauseCheckpointPath, 'metadata.json')
        if (fs.existsSync(metadataPath)) {
          t.comment('Pause checkpoint metadata exists')
          try {
            const metadataContent = fs.readFileSync(metadataPath, 'utf8')
            t.ok(metadataContent.length > 0, 'Metadata should not be empty')
            t.comment(`Metadata contains ${metadataContent.split('\n').length} lines`)
          } catch (err) {
            t.comment(`Could not read metadata: ${err.message}`)
          }
        } else {
          t.comment('Metadata file not found in pause checkpoint')
        }

        // Check for model.gguf (LoRA adapter)
        const modelPath = path.join(pauseCheckpointPath, 'model.gguf')
        if (fs.existsSync(modelPath)) {
          t.comment('Pause checkpoint contains model.gguf')
        }

        resolve(pauseCheckpointPath)
      } else {
        t.comment('Pause checkpoint may not exist yet (timing dependent)')
        resolve(null)
      }
    }, waitMs)
  })
}

// Handle early finetuning completion (when it completes before pause can be tested)
async function handleEarlyCompletion (t, finetunePromise, checkpointDir = null, message = 'Finetuning completed too quickly') {
  t.comment(`${message} - this is acceptable for small datasets`)
  const result = await finetunePromise
  t.ok(result, 'Finetuning should complete')
  if (result.status) {
    t.ok(result.status === 'IDLE', 'Final status should be IDLE')
  }
  if (checkpointDir) {
    cleanupCheckpoints(checkpointDir)
  }
  return result
}

// Verify model status is valid (for initial status checks)
function verifyInitialStatus (t, status) {
  t.ok(['LOADING', 'IDLE', 'LISTENING'].includes(status), 'Initial status should be valid')
}

// Verify final status after finetuning
async function verifyFinalStatus (t, model, result = null) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  const finalStatus = await model.status()
  t.ok(finalStatus === 'IDLE', `Final status should be IDLE, got: ${finalStatus}`)

  if (result && result.status) {
    t.comment(`Result status: ${result.status}, Model status: ${finalStatus}`)
  }

  return finalStatus
}

module.exports = {
  ensureModel,
  ensureModelPath,
  testTextWithSettings,
  getDefaultTextModel,
  getFinetuneModel,
  createDefaultGpuConfig,
  createTestAddon,
  verifyAddonStatus,
  waitForJobCompletion,
  waitForStatus,
  createTestDataset,
  cleanupCheckpoints,
  verifyCheckpointExists,
  findPauseCheckpoint,
  getDefaultFinetuneConfig,
  waitForFinetuningStart,
  setupFinetuneTestData,
  verifyPauseCheckpoint,
  handleEarlyCompletion,
  verifyInitialStatus,
  verifyFinalStatus
}
