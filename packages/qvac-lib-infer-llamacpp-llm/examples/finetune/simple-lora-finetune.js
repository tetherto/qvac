'use strict'

const LlmLlamacpp = require('../../index.js')
const FilesystemDL = require('@qvac/dl-filesystem')
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
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

async function runFinetuningTests () {
  let model
  let loader

  // Store original console methods to restore later (outside try for finally access)
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

  try {
    // Download model if needed (same pattern as reasoning.test.js)
    const [modelName, modelDir] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    // Use FilesystemDL instead of HyperDriveDL (same as reasoning.test.js)
    loader = new FilesystemDL({ dirPath: modelDir })

    const args = {
      loader,
      opts: { stats: true },
      logger: filteredLogger,
      diskPath: modelDir,
      modelName
    }

    const config = {
      gpu_layers: '999',
      ctx_size: '512',
      device: 'gpu',
      flash_attn: 'off'
    }

    model = new LlmLlamacpp(args, config)
    await model.load()

    const finetuneOptions = {
      trainDatasetDir: './examples/input/small_train_HF.jsonl',
      validation: { type: 'dataset', path: './examples/input/small_eval_HF.jsonl' },
      numberOfEpochs: 2,
      learningRate: 1e-5,
      lrMin: 1e-8,
      loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
      assistantLossOnly: true,
      checkpointSaveSteps: 2,
      checkpointSaveDir: './lora_checkpoints',
      outputParametersDir: './finetuned-model-direct'
    }

    const handle = await model.finetune(finetuneOptions)
    handle.on('stats', stats => {
      console.log(`  ${formatProgress(stats, finetuneOptions.numberOfEpochs)}`)
    })
    const finetuneResult = await handle.await()
    console.log('Finetune completed:', finetuneResult)
    if (args.opts?.stats) {
      if (finetuneResult && typeof finetuneResult.stats === 'object' && finetuneResult.stats !== null) {
        console.log('✅ Finetune terminal stats:', finetuneResult.stats)
      } else {
        console.warn('⚠️  opts.stats is enabled, but no finetune terminal stats were returned')
      }
    }
  } catch (error) {
    console.error('Test failed:', error.message)
    console.error('Stack:', error.stack)
  } finally {
    // Restore original console methods
    console.log = originalConsoleLog
    console.info = originalConsoleInfo
    console.warn = originalConsoleWarn

    if (model) {
      try {
        await model.unload()
      } catch (unloadErr) {
        console.error('Failed to unload model during cleanup:', unloadErr)
      }
    }
    if (loader) {
      try {
        await loader.close()
      } catch (closeErr) {
        console.error('Failed to close loader during cleanup:', closeErr)
      }
    }
  }
}

runFinetuningTests().catch(console.error)
