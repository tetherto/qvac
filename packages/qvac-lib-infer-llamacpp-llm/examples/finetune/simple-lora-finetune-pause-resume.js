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

const PAUSE_CHECKPOINT_PREFIX = 'pause_checkpoint_step_'

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

function listPauseCheckpointDirs (checkpointDir) {
  if (!fs.existsSync(checkpointDir)) return []
  const entries = fs.readdirSync(checkpointDir, { withFileTypes: true })
  return entries
    .filter(e => e.isDirectory() && e.name.startsWith(PAUSE_CHECKPOINT_PREFIX))
    .map(e => ({ name: e.name, step: parseInt(e.name.slice(PAUSE_CHECKPOINT_PREFIX.length), 10) }))
    .filter(p => !isNaN(p.step))
}

function latestPauseCheckpointPath (checkpointDir) {
  const dirs = listPauseCheckpointDirs(checkpointDir)
  if (dirs.length === 0) return null
  const latest = dirs.reduce((a, b) => (a.step > b.step ? a : b))
  return path.join(checkpointDir, latest.name)
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

  const suppressNoResponseMsg = (args) => {
    const msg = (args || []).map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    return msg.includes('No response found for job')
  }
  const logger = {
    info: (...a) => { if (!suppressNoResponseMsg(a)) console.info(...a) },
    log: (...a) => { if (!suppressNoResponseMsg(a)) console.log(...a) },
    warn: (...a) => { if (!suppressNoResponseMsg(a)) console.warn(...a) },
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  }

  const args = {
    loader,
    opts: { stats: true },
    logger,
    diskPath: modelDir,
    modelName
  }

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '512',
    flash_attn: 'off',
    verbosity: '2'
  }

  let client
  try {
    console.log('=== Pause/Resume Finetuning Test ===\n')
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
      batchSize: 32,
      microBatchSize: 8,
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
    console.log(`  Requested batch/micro-batch: ${finetuneOptions.batchSize}/${finetuneOptions.microBatchSize}`)
    console.log('  Compare runtime logs for: "llama_context: n_batch" and "llama_context: n_ubatch"')
    console.log('')

    try {
      const checkpointDir = finetuneOptions.checkpointSaveDir
      const existing = listPauseCheckpointDirs(checkpointDir)
      for (const { name } of existing) {
        const checkpointPath = path.join(checkpointDir, name)
        console.log(`Clearing existing pause checkpoint from previous run: ${name}...`)
        fs.rmSync(checkpointPath, { recursive: true, force: true })
      }
      if (existing.length > 0) console.log('✅ Cleared existing pause checkpoint(s)\n')
    } catch (err) {
      console.log(`⚠️  Could not clear pause checkpoint: ${err.message}\n`)
    }

    console.log('🚀 Starting finetuning...')
    const finetuneHandle = await client.finetune(finetuneOptions)
    finetuneHandle.on('stats', stats => {
      console.log(`  ${formatProgress(stats, finetuneOptions.numberOfEpochs)}`)
    })

    console.log('Waiting for 5 training steps before pausing...')
    await waitForProgress(finetuneHandle, 5)

    console.log('')
    console.log('⏸️  Pausing finetuning...')
    await client.pause()
    const pauseResult = await finetuneHandle.await()
    console.log('Pause result:', pauseResult)

    if (pauseResult?.status === 'COMPLETED') {
      console.log('✅ Training completed before pause took effect\n')
      console.log('\n=== Test Complete ===')
      return
    }

    console.log('✅ Finetuning is now PAUSED\n')

    console.log('Verifying pause checkpoint was created...')
    const maxRetries = 10
    const retryDelayMs = 500
    for (let retry = 0; retry < maxRetries; retry++) {
      const pausePath = latestPauseCheckpointPath(finetuneOptions.checkpointSaveDir)
      if (pausePath && fs.existsSync(path.join(pausePath, 'metadata.txt'))) {
        console.log(`✅ Pause checkpoint directory exists: ${pausePath}`)
        console.log('✅ Pause checkpoint metadata file exists')
        break
      }
      if (retry === maxRetries - 1) {
        console.log(`⚠️  No pause checkpoint found after ${maxRetries} retries (checkpoint may still be saving)`)
      } else {
        await sleep(retryDelayMs)
      }
    }
    console.log('')

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
      const hasPause = listPauseCheckpointDirs(finetuneOptions.checkpointSaveDir).length > 0
      console.log(hasPause
        ? '⚠️  Pause checkpoint still exists (may be normal if training was paused at end)'
        : '✅ Pause checkpoint was cleared after completion')
    } catch (_) {}

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
