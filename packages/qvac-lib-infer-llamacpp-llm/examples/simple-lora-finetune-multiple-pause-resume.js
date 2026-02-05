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
    return await model.addon.status()
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
      // Retry silently
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

  try {
    console.log('=== Multiple Pause/Resume Finetuning Test ===\n')
    console.log('Loading model...')
    client = new LlamaClient(args, config)

    // Store original _createAddon if it exists
    const originalCreateAddon = client._createAddon?.bind(client)

    // Override _createAddon to filter out unwanted log messages
    if (originalCreateAddon) {
      client._createAddon = function (configurationParams, finetuningParams) {
        const originalOutputCb = this._outputCallback?.bind(this)
        this._outputCallback = function (instance, eventType, jobId, data, extra) {
          // Filter out "No response found for job" messages
          const dataStr = typeof data === 'string' ? data : (data?.message || JSON.stringify(data) || '')
          if (dataStr && dataStr.includes('No response found for job')) {
            return // Suppress these messages
          }
          
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
      numberOfEpochs: 5,
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

    // Wait for training to start
    await waitForStatus(client, 'FINETUNING', { pollIntervalMs: 200, timeoutMs: 30000 })
    console.log('✅ Training started\n')

    // Helper function to get pause step number from checkpoint directory
    async function getPauseStepNumber (checkpointDir) {
      const maxRetries = 10
      const retryDelayMs = 500

      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          if (fs.existsSync(checkpointDir)) {
            const entries = fs.readdirSync(checkpointDir, { withFileTypes: true })
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
                  }
                }
              }
            }

            if (latestStep >= 0) {
              return latestStep
            }
          }
        } catch (err) {
          // Continue retrying
        }

        if (retry < maxRetries - 1) {
          await sleep(retryDelayMs)
        }
      }

      return null
    }

    // Multiple pause/resume cycles: train 90s -> pause -> wait 10s -> resume -> train 90s -> repeat
    const trainSeconds = 90
    const resumeWaitSeconds = 10
    const numberOfCycles = 2

    for (let cycle = 1; cycle <= numberOfCycles; cycle++) {
      console.log(`\n${'='.repeat(60)}`)
      console.log(`Pause/Resume Cycle ${cycle}`)
      console.log(`${'='.repeat(60)}\n`)

      // Train for 1 minute 30 seconds
      console.log(`Training for ${trainSeconds} seconds (1 minute 30 seconds)...`)
      await sleep(trainSeconds * 1000)

      // Pause finetuning
      console.log(`⏸️  Pausing finetuning (cycle ${cycle})...`)
      await client.pauseFinetune()

      // Wait for status to change to PAUSED
      await waitForStatus(client, 'PAUSED', { pollIntervalMs: 200, timeoutMs: 15000 })
      
      // Get and log the step number at which finetuning was paused
      const pauseStep = await getPauseStepNumber(finetuneOptions.checkpointSaveDir)
      if (pauseStep !== null) {
        console.log(`✅ Finetuning paused at step ${pauseStep} (cycle ${cycle})\n`)
      } else {
        console.log(`✅ Finetuning is now PAUSED (cycle ${cycle})\n`)
      }

      // Store the pause step for resume logging (checkpoint gets cleared after resume)
      const resumeCheckpointStep = pauseStep

      // Wait 10 seconds before resuming
      await sleep(resumeWaitSeconds * 1000)

      // Verify checkpoint still exists before resuming
      const checkpointBeforeResume = await getPauseStepNumber(finetuneOptions.checkpointSaveDir)
      if (resumeCheckpointStep !== null && checkpointBeforeResume !== resumeCheckpointStep) {
        console.log(`⚠️  Warning: Expected checkpoint step ${resumeCheckpointStep} but found ${checkpointBeforeResume} before resume (cycle ${cycle})`)
      }

      // Resume finetuning
      console.log(`▶️  Resuming finetuning (cycle ${cycle})...`)
      if (resumeCheckpointStep !== null) {
        console.log(`   Expected to resume from checkpoint step ${resumeCheckpointStep}`)
      }
      await client.resumeFinetune()

      // Wait for status to change back to FINETUNING
      await waitForStatus(client, 'FINETUNING', { pollIntervalMs: 200, timeoutMs: 15000 })
      
      // Verify checkpoint was cleared after resume (it should be)
      const checkpointAfterResume = await getPauseStepNumber(finetuneOptions.checkpointSaveDir)
      if (checkpointAfterResume !== null) {
        console.log(`⚠️  Warning: Checkpoint still exists after resume at step ${checkpointAfterResume} (cycle ${cycle})`)
      }
      
      if (resumeCheckpointStep !== null) {
        // Training resumes from checkpoint at step X and continues from step X+1
        const resumeFromStep = resumeCheckpointStep + 1
        console.log(`✅ Finetuning has RESUMED from checkpoint step ${resumeCheckpointStep}, continuing from step ${resumeFromStep} (cycle ${cycle})\n`)
      } else {
        console.log(`✅ Finetuning has RESUMED (cycle ${cycle})\n`)
      }
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log('All pause/resume cycles completed')
    console.log(`${'='.repeat(60)}\n`)

    // Wait for completion
    const finetuneResult = await finetuneTask
    console.log('\n✅ Finetune completed:', finetuneResult)

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
        await client.unload()
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
