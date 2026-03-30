'use strict'

const LlamaClient = require('../../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')
const { downloadModel, formatProgress, createFilteredLogger } = require('../utils')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function waitForProgress (handle, minSteps, timeoutMs) {
  minSteps = minSteps || 5
  timeoutMs = timeoutMs || 300_000
  return new Promise((resolve, reject) => {
    let count = 0
    const timer = setTimeout(() => {
      handle.removeListener('stats', onStats)
      reject(new Error(`waitForProgress: no progress after ${timeoutMs}ms (received ${count}/${minSteps} steps)`))
    }, timeoutMs)
    const onStats = () => {
      if (++count >= minSteps) {
        clearTimeout(timer)
        handle.removeListener('stats', onStats)
        resolve()
      }
    }
    handle.on('stats', onStats)
  })
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
    return stepB - stepA // Descending order
  })

  return path.join(checkpointDir, pauseCheckpoints[0])
}

async function runInference (client, description, messages) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🔮 Starting inference: ${description}`)
  console.log(`${'='.repeat(60)}`)
  console.log('Prompt:', messages[messages.length - 1].content)
  console.log('\nResponse:')

  const response = await client.run(messages)
  await response.onUpdate(token => {
    process.stdout.write(token)
  }).await()
  console.log('\n')
  console.log(`✅ Inference completed: ${description}`)
}

async function main () {
  const [modelName, modelDir] = await downloadModel(MODEL.url, MODEL.name)

  const trainDatasetPath = './examples/input/small_train_HF.jsonl'
  const evalDatasetPath = './examples/input/small_eval_HF.jsonl'

  const loader = new FilesystemDL({ dirPath: modelDir })

  const { logger: filteredLogger, restore: restoreConsole } = createFilteredLogger()

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
    console.log('=== Pause Finetuning, Inference, and Resume Test ===\n')
    console.log('Loading model...')
    client = new LlamaClient(args, config)

    await client.load()
    console.log('Model loaded successfully\n')

    const finetuneOptions = {
      trainDatasetDir: trainDatasetPath,
      validation: { type: 'dataset', path: evalDatasetPath },
      numberOfEpochs: 2,
      learningRate: 1e-5,
      lrMin: 1e-8,
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

    console.log('🚀 Starting finetuning...')
    const finetuneHandle = await client.finetune(finetuneOptions)
    finetuneHandle.on('stats', stats => {
      console.log(`  ${formatProgress(stats, finetuneOptions.numberOfEpochs)}`)
    })

    console.log('Waiting for 10 training steps before pausing...')
    await waitForProgress(finetuneHandle, 10)

    console.log('⏸️  Pausing finetuning...')
    await client.pause()
    const pauseResult = await finetuneHandle.await()

    if (pauseResult?.status === 'COMPLETED') {
      console.log('✅ Training completed before pause took effect\n')
      console.log('\n✅ Finetune completed:', pauseResult)
      console.log('\n=== Test Complete ===')
      return
    }

    console.log('✅ Finetuning is now PAUSED:', pauseResult?.status, '\n')

    console.log('Verifying pause checkpoint was created...')
    let pauseCheckpointPath = null
    const maxRetries = 10
    const retryDelayMs = 500

    for (let retry = 0; retry < maxRetries; retry++) {
      pauseCheckpointPath = findPauseCheckpoint(finetuneOptions.checkpointSaveDir)
      if (pauseCheckpointPath) {
        const metadataPath = path.join(pauseCheckpointPath, 'metadata.txt')
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

    const inferenceMessages = [
      { role: 'system', content: 'You are a helpful healthcare assistant.' },
      {
        role: 'user',
        content: "Do nurses' involvement in patient education improve outcomes?"
      }
    ]

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

      console.log('🔮 Preparing inference 1: Loading model with LoRA adapter...')
      inferenceClientWithLora = new LlamaClient(args, inferenceConfigWithLora)
      await inferenceClientWithLora.load()
      console.log('✅ Model with LoRA adapter loaded successfully\n')

      await runInference(inferenceClientWithLora, 'Paused checkpoint with LoRA adapters', inferenceMessages)
    } finally {
      if (inferenceClientWithLora) {
        console.log('Unloading inference client with LoRA...')
        await inferenceClientWithLora.unload()
        console.log('✅ Inference client with LoRA unloaded\n')
      }
    }

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
      }

      console.log('🔮 Preparing inference 2: Loading base model (no LoRA adapters)...')
      inferenceClientBase = new LlamaClient(args, inferenceConfigBase)
      await inferenceClientBase.load()
      console.log('✅ Base model loaded successfully\n')

      await runInference(inferenceClientBase, 'Base model without LoRA adapters', inferenceMessages)
    } finally {
      if (inferenceClientBase) {
        console.log('Unloading base model inference client...')
        await inferenceClientBase.unload()
        console.log('✅ Base model inference client unloaded\n')
      }
    }

    console.log('\n' + '='.repeat(60))
    console.log('Step 3: Resuming finetuning')
    console.log('='.repeat(60))
    console.log('▶️  Resuming finetuning...')
    const resumeHandle = await client.finetune(finetuneOptions)
    resumeHandle.on('stats', stats => {
      console.log(`  ${formatProgress(stats, finetuneOptions.numberOfEpochs)}`)
    })
    console.log('✅ Finetuning has RESUMED\n')

    console.log('Waiting for finetuning to complete...')
    const finetuneResult = await resumeHandle.await()
    console.log('\n✅ Finetune completed:', finetuneResult)

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
    } catch (_) {}

    console.log('\n=== Test Complete ===')
  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
    console.error('Stack:', error.stack)
    process.exit(1)
  } finally {
    restoreConsole()

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
