'use strict'

const LlamaClient = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

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
      console.log(`Status check failed: ${error.message}, retrying...`)
    }
    await sleep(pollIntervalMs)
  }
  throw new Error(`Timeout waiting for status ${expected}`)
}

async function main () {
  const baseModelPath = './models/Qwen3_0.6B.Q8_0.gguf'
  const trainDatasetPath = './models/train_HF.jsonl'
  const evalDatasetPath = './models/eval_HF.jsonl'

  const loader = new FilesystemDL({ dirPath: path.dirname(baseModelPath) })

  const args = {
    loader,
    opts: { stats: true },
    logger: console,
    diskPath: path.dirname(baseModelPath),
    modelName: path.basename(baseModelPath)
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

    // Override the _outputCallback to capture C++ log messages
    // Note: _outputCallback is set during _createAddon, so we need to override it after load
    // But we can set up a wrapper that will be used
    console.log('[JS] Setting up log message capture...')

    // Store original _createAddon if it exists
    const originalCreateAddon = client._createAddon?.bind(client)

    // Override _createAddon to intercept the output callback
    if (originalCreateAddon) {
      client._createAddon = function (configurationParams, finetuningParams) {
        const originalOutputCb = this._outputCallback?.bind(this)
        this._outputCallback = function (instance, eventType, jobId, data, extra) {
          if (eventType === 'LogMsg') {
            const logMsg = typeof data === 'string' ? data : (data?.message || JSON.stringify(data))
            logMessages.push(logMsg)
            console.log(`[C++ LOG] ${logMsg}`)
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
    console.log('[JS] Calling client.finetune()...')
    const finetuneTask = client.finetune(finetuneOptions)
    console.log('[JS] client.finetune() returned, task:', finetuneTask)

    // Wait for training to start
    console.log('Waiting for training to start...')
    // Check status a few times to see what's happening
    for (let i = 0; i < 5; i++) {
      await sleep(500)
      await getStatus(client)
    }
    await waitForStatus(client, 'FINETUNING', { pollIntervalMs: 200, timeoutMs: 30000 })
    console.log('✅ Training started\n')

    // Wait a bit to let some training happen
    console.log('Training for 8 seconds...')
    await sleep(8000)

    const statusBeforePause = await getStatus(client)
    console.log(`Status before pause: ${statusBeforePause}\n`)

    // Pause finetuning
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
    console.log('▶️  Resuming finetuning...')
    await client.resumeFinetune()

    // Wait for status to change back to FINETUNING
    console.log('Waiting for status to change to FINETUNING...')
    await waitForStatus(client, 'FINETUNING', { pollIntervalMs: 200, timeoutMs: 15000 })
    console.log('✅ Finetuning has RESUMED\n')

    // Wait a bit more to see training continue
    console.log('Training for another 5 seconds after resume...')
    await sleep(5000)

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
