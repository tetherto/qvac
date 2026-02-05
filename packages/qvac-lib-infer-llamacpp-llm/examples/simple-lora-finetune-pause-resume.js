'use strict'

const LlamaClient = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')
const https = require('bare-https')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

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
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            return safeReject(unlinkErr)
          }

          let redirectUrl = response.headers.location
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
  const modelDir = path.resolve('./models')

  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    console.log(`Found ${modelName}: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
    return [modelName, modelDir]
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`Downloading test model ${modelName}...`)

  await downloadFile(downloadUrl, modelPath)

  const stats = fs.statSync(modelPath)
  console.log(`Model ready: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
  return [modelName, modelDir]
}

async function getStatus (model) {
  if (model.addon) {
    const status = await model.addon.status()
    return status
  }
  throw new Error('Addon not initialized')
}

async function waitForStatus (model, expected, { pollIntervalMs = 200, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      const current = await getStatus(model)
      if (current === expected) {
        return current
      }
    } catch (error) {
      console.log(`Status check failed: ${error.message}, retrying...`)
    }
    await sleep(pollIntervalMs)
  }
  throw new Error(`Timeout waiting for status ${expected}`)
}

async function main () {
  const [modelName, modelDir] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const trainDatasetPath = './models/small_train_HF.jsonl'
  const evalDatasetPath = './models/eval_HF.jsonl'

  const loader = new FilesystemDL({ dirPath: modelDir })

  // Store original console methods to restore later
  const originalConsoleLog = console.log
  const originalConsoleInfo = console.info
  const originalConsoleWarn = console.warn

  // Helper to check if message should be suppressed
  const shouldSuppressMessage = (args) => {
    const message = args.join(' ')
    return message && message.includes('No response found for job')
  }

  // Override console methods to filter out "No response found for job" messages
  console.log = (...args) => {
    if (shouldSuppressMessage(args)) return
    originalConsoleLog.apply(console, args)
  }

  console.info = (...args) => {
    if (shouldSuppressMessage(args)) return
    originalConsoleInfo.apply(console, args)
  }

  // CRITICAL: BaseInference uses logger.warn() for "No response found for job"
  console.warn = (...args) => {
    if (shouldSuppressMessage(args)) return
    originalConsoleWarn.apply(console, args)
  }

  // Create a filtered logger that suppresses "No response found for job" messages
  const filteredLogger = {
    info: (...args) => {
      if (shouldSuppressMessage(args)) return
      originalConsoleInfo.apply(console, args)
    },
    log: (...args) => {
      if (shouldSuppressMessage(args)) return
      originalConsoleLog.apply(console, args)
    },
    // CRITICAL: BaseInference._outputCallback uses logger.warn() not logger.info()
    warn: (...args) => {
      if (shouldSuppressMessage(args)) return
      originalConsoleWarn.apply(console, args)
    },
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  }

  const args = {
    loader,
    opts: { stats: true },
    logger: filteredLogger,
    diskPath: modelDir,
    modelName
  }

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '512',
    flash_attn: 'off'
  }

  let client
  const logMessages = []

  try {
    console.log('=== Pause/Resume Finetuning Test ===\n')
    console.log('Loading model...')
    client = new LlamaClient(args, config)

    // Store original _createAddon if it exists
    const originalCreateAddon = client._createAddon?.bind(client)

    // Override _createAddon to intercept the output callback
    if (originalCreateAddon) {
      client._createAddon = function (configurationParams, finetuningParams) {
        const originalOutputCb = this._outputCallback?.bind(this)
        this._outputCallback = function (instance, eventType, jobId, data, extra) {
          // Filter out "No response found for job" messages that interfere with progress bar
          // These can come from any event type, so check all of them
          const dataStr = typeof data === 'string' ? data : (data?.message || JSON.stringify(data) || '')
          if (dataStr && dataStr.includes('No response found for job')) {
            return // Suppress these messages during finetuning - don't call originalOutputCb
          }
          
          if (eventType === 'LogMsg') {
            const logMsg = dataStr
            logMessages.push(logMsg)
            console.log(logMsg)
          }
          
          // Only call originalOutputCb if we haven't filtered the message
          if (originalOutputCb) {
            return originalOutputCb(instance, eventType, jobId, data, extra)
          }
        }
        return originalCreateAddon(configurationParams, finetuningParams)
      }
    }

    await client.load()
    console.log('Model loaded successfully\n')

    const finetuneOptions = {
      trainDatasetDir: trainDatasetPath,
      evalDatasetDir: evalDatasetPath,
      numberOfEpochs: 2,
      learningRate: 1e-5,
      lrMin: 1e-8,
      lrScheduler: 'cosine',
      warmupRatio: 0.1,
      contextLength: 128,
      batchSize: 128,
      microBatchSize: 128,
      loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
      assistantLossOnly: true,
      checkpointSaveSteps: 10,
      checkpointSaveDir: './lora_checkpoints',
      outputParametersDir: './finetuned-model-direct'
    }

    console.log('Finetuning configuration:')
    console.log(`  Epochs: ${finetuneOptions.numberOfEpochs}`)
    console.log(`  Learning rate: ${finetuneOptions.learningRate}`)
    console.log(`  Checkpoint every: ${finetuneOptions.checkpointSaveSteps} steps`)
    console.log(`  Checkpoint directory: ${finetuneOptions.checkpointSaveDir}`)
    console.log('')

    // Clear any existing pause checkpoint from previous runs
    // C++ uses step-based naming: pause_checkpoint_step_XXXXXXXX
    try {
      const checkpointDir = finetuneOptions.checkpointSaveDir
      if (fs.existsSync(checkpointDir)) {
        const entries = fs.readdirSync(checkpointDir, { withFileTypes: true })
        let clearedAny = false
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('pause_checkpoint_step_')) {
            const checkpointPath = path.join(checkpointDir, entry.name)
            console.log(`Clearing existing pause checkpoint from previous run: ${entry.name}...`)
            fs.rmSync(checkpointPath, { recursive: true, force: true })
            clearedAny = true
          }
        }
        if (clearedAny) {
          console.log('✅ Cleared existing pause checkpoint(s)\n')
        }
      }
    } catch (err) {
      console.log(`⚠️  Could not clear pause checkpoint: ${err.message}\n`)
    }

    // Start finetuning (non-blocking)
    console.log('🚀 Starting finetuning...')
    const finetuneTask = client.finetune(finetuneOptions)

    // Wait for training to actually start (status should change to FINETUNING)
    console.log('Waiting for training to start...')
    await waitForStatus(client, 'FINETUNING', { pollIntervalMs: 200, timeoutMs: 10000 })
    console.log('✅ Training has started\n')
    
    // Wait for several batches to complete before pausing
    // This ensures we have meaningful training progress before testing pause
    console.log('Training for 1 minute 30 seconds to allow several batches to complete...')
    await sleep(90000)
    
    // Print newline to separate from progress bar before pausing
    console.log('') // Newline to ensure pause message appears on clean line
    console.log('⏸️  Pausing finetuning...')
    await client.pauseFinetune()

    // Wait for status to change to PAUSED
    console.log('Waiting for status to change to PAUSED...')
    await waitForStatus(client, 'PAUSED', { pollIntervalMs: 200, timeoutMs: 15000 })
    console.log('✅ Finetuning is now PAUSED\n')

    // Verify pause checkpoint was created
    // C++ uses step-based naming: pause_checkpoint_step_XXXXXXXX
    // Note: Checkpoint is saved asynchronously in the callback after the next batch,
    // so we need to retry with a delay to wait for it to be created
    console.log('Verifying pause checkpoint was created...')
    let checkpointFound = false
    const maxRetries = 10
    const retryDelayMs = 500

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        const checkpointDir = finetuneOptions.checkpointSaveDir
        if (!fs.existsSync(checkpointDir)) {
          if (retry === maxRetries - 1) {
            console.log(`⚠️  Checkpoint directory does not exist: ${checkpointDir}`)
          }
        } else {
          // Find the latest pause checkpoint directory
          const entries = fs.readdirSync(checkpointDir, { withFileTypes: true })
          let latestCheckpoint = null
          let latestStep = -1

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const dirName = entry.name
              const prefix = 'pause_checkpoint_step_'
              if (dirName.startsWith(prefix)) {
                const stepStr = dirName.substring(prefix.length)
                const step = parseInt(stepStr, 10)
                if (!isNaN(step) && step > latestStep) {
                  latestStep = step
                  latestCheckpoint = dirName
                }
              }
            }
          }

          if (latestCheckpoint) {
            const pauseCheckpointPathVerify = path.join(checkpointDir, latestCheckpoint)
            // Check for key files to ensure checkpoint is complete
            const metadataPath = path.join(pauseCheckpointPathVerify, 'metadata.json')
            if (fs.existsSync(metadataPath)) {
              console.log(`✅ Pause checkpoint directory exists: ${pauseCheckpointPathVerify}`)
              console.log('✅ Pause checkpoint metadata file exists')
              checkpointFound = true
              break
            }
          }
        }
      } catch (err) {
        if (retry === maxRetries - 1) {
          console.log(`⚠️  Could not verify pause checkpoint: ${err.message}`)
        }
      }

      if (!checkpointFound && retry < maxRetries - 1) {
        await sleep(retryDelayMs)
      }
    }

    if (!checkpointFound) {
      console.log(`⚠️  No pause checkpoint directory found after ${maxRetries} retries (checkpoint may still be saving)`)
    }
    console.log('')

    // Keep it paused for a bit
    console.log('Keeping finetuning paused for 5 seconds...')
    await sleep(5000)

    // Resume finetuning
    // Print newline to separate from any progress bar output
    console.log('') // Newline to ensure resume message appears on clean line
    console.log('▶️  Resuming finetuning...')
    await client.resumeFinetune()

    // Wait for status to change back to FINETUNING
    console.log('Waiting for status to change to FINETUNING...')
    await waitForStatus(client, 'FINETUNING', { pollIntervalMs: 200, timeoutMs: 15000 })
    console.log('✅ Finetuning has RESUMED')
    
    // Wait a moment for any initialization messages to complete, then print newline
    // to ensure progress bar starts on a clean line
    await sleep(500)
    console.log('') // Newline to separate progress bar from resume messages

    // Wait for completion
    console.log('Waiting for finetuning to complete...')
    const finetuneResult = await finetuneTask
    console.log('\n✅ Finetune completed:', finetuneResult)

    const finalStatus = await getStatus(client)
    console.log(`Final status: ${finalStatus}`)

    // Verify pause checkpoint was cleared after completion
    try {
      const checkpointDir = finetuneOptions.checkpointSaveDir
      if (!fs.existsSync(checkpointDir)) {
        console.log('✅ Pause checkpoint was cleared after completion')
      } else {
        // Check if any pause checkpoint directories exist
        const entries = fs.readdirSync(checkpointDir, { withFileTypes: true })
        const hasPauseCheckpoint = entries.some(entry => {
          if (entry.isDirectory()) {
            return entry.name.startsWith('pause_checkpoint_step_')
          }
          return false
        })

        if (!hasPauseCheckpoint) {
          console.log('✅ Pause checkpoint was cleared after completion')
        } else {
          console.log('⚠️  Pause checkpoint still exists (may be normal if training was paused at end)')
        }
      }
    } catch (err) {
      // Ignore errors
    }

    console.log('\n=== Test Complete ===')
  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
    console.error('Stack:', error.stack)
    process.exit(1)
  } finally {
    // Restore original console methods
    console.log = originalConsoleLog
    console.info = originalConsoleInfo
    console.warn = originalConsoleWarn

    if (client) {
      try {
        console.log('\nCleaning up...')
        await client.unload()
        console.log('Model unloaded')
      } catch (unloadErr) {
        console.error('Failed to unload model during cleanup:', unloadErr)
      }
    }
  }
}

main().catch(async error => {
  console.error('\n❌ Fatal error:', error.message)
  console.error('Stack:', error.stack)
  process.exit(1)
})
