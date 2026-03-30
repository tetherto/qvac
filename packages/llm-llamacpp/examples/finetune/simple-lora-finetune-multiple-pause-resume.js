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
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      handle.removeListener('stats', onStats)
      reject(new Error(`waitForProgress: no progress after ${timeoutMs}ms (received ${count}/${minSteps} steps)`))
    }, timeoutMs)
    const onStats = () => {
      if (settled) return
      if (++count >= minSteps) {
        settled = true
        clearTimeout(timer)
        handle.removeListener('stats', onStats)
        resolve()
      }
    }
    handle.on('stats', onStats)
    handle.await().then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      handle.removeListener('stats', onStats)
      resolve()
    })
  })
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
    console.log('=== Multiple Pause/Resume Finetuning Test ===\n')
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

    const attachProgressLogger = (handle) => {
      handle.on('stats', stats => {
        console.log(`  ${formatProgress(stats, finetuneOptions.numberOfEpochs)}`)
      })
    }

    console.log('🚀 Starting finetuning...')
    let finetuneHandle = await client.finetune(finetuneOptions)
    attachProgressLogger(finetuneHandle)

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
        } catch (_) {}

        if (retry < maxRetries - 1) {
          await sleep(retryDelayMs)
        }
      }

      return null
    }

    const stepsBeforePause = 10
    const numberOfCycles = 2
    let trainingFinished = false

    for (let cycle = 1; cycle <= numberOfCycles; cycle++) {
      console.log(`\n${'='.repeat(60)}`)
      console.log(`Pause/Resume Cycle ${cycle}`)
      console.log(`${'='.repeat(60)}\n`)

      console.log(`Waiting for ${stepsBeforePause} training steps before pausing...`)
      await waitForProgress(finetuneHandle, stepsBeforePause)

      console.log(`⏸️  Pausing finetuning (cycle ${cycle})...`)
      await client.pause()
      const pauseResult = await finetuneHandle.await()

      if (pauseResult?.status === 'COMPLETED') {
        console.log(`✅ Training completed before pause took effect (cycle ${cycle})`)
        trainingFinished = true
        break
      }

      if (pauseResult?.status !== 'PAUSED') {
        console.log(`⚠️  Unexpected pause status: ${pauseResult?.status} (cycle ${cycle})`)
      }

      const pauseStep = await getPauseStepNumber(finetuneOptions.checkpointSaveDir)
      if (pauseStep !== null) {
        console.log(`✅ Finetuning paused at step ${pauseStep} (cycle ${cycle})\n`)
      } else {
        console.log(`✅ Finetuning is now PAUSED (cycle ${cycle})\n`)
      }

      const resumeCheckpointStep = pauseStep

      const checkpointBeforeResume = await getPauseStepNumber(finetuneOptions.checkpointSaveDir)
      if (resumeCheckpointStep !== null && checkpointBeforeResume !== resumeCheckpointStep) {
        console.log(`⚠️  Warning: Expected checkpoint step ${resumeCheckpointStep} but found ${checkpointBeforeResume} before resume (cycle ${cycle})`)
      }

      console.log(`▶️  Resuming finetuning (cycle ${cycle})...`)
      if (resumeCheckpointStep !== null) {
        console.log(`   Expected to resume from checkpoint step ${resumeCheckpointStep}`)
      }
      finetuneHandle = await client.finetune(finetuneOptions)
      attachProgressLogger(finetuneHandle)

      const checkpointAfterResume = await getPauseStepNumber(finetuneOptions.checkpointSaveDir)
      if (checkpointAfterResume !== null) {
        console.log(`⚠️  Warning: Checkpoint still exists after resume at step ${checkpointAfterResume} (cycle ${cycle})`)
      }

      if (resumeCheckpointStep !== null) {
        const resumeFromStep = resumeCheckpointStep + 1
        console.log(`✅ Finetuning has RESUMED from checkpoint step ${resumeCheckpointStep}, continuing from step ${resumeFromStep} (cycle ${cycle})\n`)
      } else {
        console.log(`✅ Finetuning has RESUMED (cycle ${cycle})\n`)
      }
    }

    if (!trainingFinished) {
      console.log(`\n${'='.repeat(60)}`)
      console.log('All pause/resume cycles completed, waiting for training to finish...')
      console.log(`${'='.repeat(60)}\n`)
    }

    const finetuneResult = await finetuneHandle.await()
    console.log('\n✅ Finetune completed:', finetuneResult)

    console.log('\n=== Test Complete ===')
  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
    console.error('Stack:', error.stack)
    process.exit(1)
  } finally {
    restoreConsole()

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
