'use strict'

const LlamaClient = require('../../index')
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

function formatTime (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function makeProgressBar (current, total, width) {
  width = width || 20
  if (!total || total <= 0) return '[' + ' '.repeat(width) + ']'
  const filled = Math.round((current / total) * width)
  return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled) + ']'
}

function formatProgress (stats, totalEpochs) {
  const isTrain = stats.is_train !== false
  const phase = isTrain ? 'train' : 'val  '
  const epoch = Number.isFinite(stats.current_epoch) ? stats.current_epoch + 1 : 1
  const bar = makeProgressBar(stats.current_batch, stats.total_batches)
  const batchStr = `${stats.current_batch}/${stats.total_batches}`
  const loss = Number.isFinite(stats.loss) ? stats.loss.toFixed(4) : 'n/a'
  const acc = Number.isFinite(stats.accuracy) ? (stats.accuracy * 100).toFixed(1) + '%' : 'n/a'
  const elapsed = formatTime(stats.elapsed_ms)
  const eta = formatTime(stats.eta_ms)
  const stepStr = isTrain ? ` step=${stats.global_steps}` : ''
  return `${phase} epoch ${epoch}/${totalEpochs} ${bar} ${batchStr} | loss=${loss} acc=${acc}${stepStr} | ${elapsed}<${eta}`
}

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

async function main () {
  const [modelName, modelDir] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const trainDatasetPath = './examples/input/small_train_HF.jsonl'
  const evalDatasetPath = './examples/input/small_eval_HF.jsonl'

  const loader = new FilesystemDL({ dirPath: modelDir })

  const originalConsoleLog = console.log
  const originalConsoleInfo = console.info
  const originalConsoleWarn = console.warn

  const shouldSuppressMessage = (args) => {
    const message = args.join(' ')
    return message && message.includes('No response found for job')
  }

  console.log = (...args) => {
    if (shouldSuppressMessage(args)) return
    originalConsoleLog.apply(console, args)
  }

  console.info = (...args) => {
    if (shouldSuppressMessage(args)) return
    originalConsoleInfo.apply(console, args)
  }

  console.warn = (...args) => {
    if (shouldSuppressMessage(args)) return
    originalConsoleWarn.apply(console, args)
  }

  const filteredLogger = {
    info: (...args) => {
      if (shouldSuppressMessage(args)) return
      originalConsoleInfo.apply(console, args)
    },
    log: (...args) => {
      if (shouldSuppressMessage(args)) return
      originalConsoleLog.apply(console, args)
    },
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
