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

async function runInference (client, description, messages) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Running inference: ${description}`)
  console.log(`${'='.repeat(60)}`)
  console.log('Prompt:', messages[messages.length - 1].content)
  console.log('\nResponse:')

  const response = await client.run(messages)
  await response.onUpdate(token => {
    process.stdout.write(token)
  }).await()
  console.log('\n')
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
    console.log('=== Pause Finetuning, Inference, and Resume Test ===\n')
    console.log('Loading model...')
    client = new LlamaClient(args, config)

    // Override the _outputCallback to capture C++ log messages
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
    console.log('Waiting for training to start...')
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

    // Verify pause checkpoint was created and find it
    console.log('Verifying pause checkpoint was created...')
    let pauseCheckpointPath = null
    const maxRetries = 10
    const retryDelayMs = 500

    for (let retry = 0; retry < maxRetries; retry++) {
      pauseCheckpointPath = findPauseCheckpoint(finetuneOptions.checkpointSaveDir)
      if (pauseCheckpointPath) {
        const metadataPath = path.join(pauseCheckpointPath, 'metadata.json')
        const modelPath = path.join(pauseCheckpointPath, 'model.gguf')
        if (fs.existsSync(metadataPath) && fs.existsSync(modelPath)) {
          console.log(`✅ Pause checkpoint found: ${pauseCheckpointPath}`)
          console.log('✅ Pause checkpoint metadata and model files exist')
          break
        }
      }
      if (retry < maxRetries - 1) {
        await sleep(retryDelayMs)
      }
    }

    if (!pauseCheckpointPath) {
      throw new Error(`No pause checkpoint found after ${maxRetries} retries`)
    }

    const loraAdapterPath = path.join(pauseCheckpointPath, 'model.gguf')
    console.log(`LoRA adapter path: ${loraAdapterPath}\n`)

    // Prepare inference messages
    const inferenceMessages = [
      { role: 'system', content: 'You are a helpful healthcare assistant.' },
      {
        role: 'user',
        content: "Do nurses' involvement in patient education improve outcomes?"
      }
    ]

    // Inference 1: Run inference on the paused checkpoint (with LoRA adapters)
    console.log('\n' + '='.repeat(60))
    console.log('Step 1: Inference on paused checkpoint (with LoRA adapters)')
    console.log('='.repeat(60))
    let inferenceClientWithLora = null
    try {
      const inferenceConfigWithLora = {
        device: 'gpu',
        gpu_layers: '999',
        ctx_size: '4096',
        temp: '0.0',
        n_predict: '256',
        lora: loraAdapterPath
      }

      console.log('Loading model with LoRA adapter for inference...')
      inferenceClientWithLora = new LlamaClient(args, inferenceConfigWithLora)
      await inferenceClientWithLora.load()
      console.log('Model with LoRA adapter loaded successfully\n')

      await runInference(inferenceClientWithLora, 'Paused checkpoint with LoRA adapters', inferenceMessages)
    } finally {
      if (inferenceClientWithLora) {
        console.log('Unloading inference client with LoRA...')
        await inferenceClientWithLora.unload()
        console.log('✅ Inference client with LoRA unloaded\n')
      }
    }

    // Inference 2: Run inference on the base model without LoRA adapters
    console.log('\n' + '='.repeat(60))
    console.log('Step 2: Inference on base model (without LoRA adapters)')
    console.log('='.repeat(60))
    let inferenceClientBase = null
    try {
      const inferenceConfigBase = {
        device: 'gpu',
        gpu_layers: '999',
        ctx_size: '4096',
        temp: '0.0',
        n_predict: '256'
        // Note: No 'lora' parameter - using base model only
      }

      console.log('Loading base model for inference (no LoRA adapters)...')
      inferenceClientBase = new LlamaClient(args, inferenceConfigBase)
      await inferenceClientBase.load()
      console.log('Base model loaded successfully\n')

      await runInference(inferenceClientBase, 'Base model without LoRA adapters', inferenceMessages)
    } finally {
      if (inferenceClientBase) {
        console.log('Unloading base model inference client...')
        await inferenceClientBase.unload()
        console.log('✅ Base model inference client unloaded\n')
      }
    }

    // Resume finetuning
    console.log('\n' + '='.repeat(60))
    console.log('Step 3: Resuming finetuning')
    console.log('='.repeat(60))
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
