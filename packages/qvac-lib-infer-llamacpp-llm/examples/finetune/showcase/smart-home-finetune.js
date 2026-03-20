'use strict'

const LlamaClient = require('../../../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const process = require('bare-process')
const { downloadModel } = require('../../utils')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const TRAIN_DATASET = './examples/input/smart_home_specialist_train.jsonl'
const CHECKPOINT_DIR = './smart-home-lora-checkpoints'
const OUTPUT_DIR = './smart-home-lora'

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
  width = width || 30
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

async function main () {
  let client
  let loader

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

  try {
    console.log('='.repeat(70))
    console.log('  Smart Home Specialist LoRA Finetune')
    console.log('  Model:   ' + MODEL.name)
    console.log('  Dataset: ' + TRAIN_DATASET)
    console.log('='.repeat(70) + '\n')

    const [modelName, modelDir] = await downloadModel(MODEL.url, MODEL.name)

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
      ctx_size: '1024',
      device: 'gpu',
      flash_attn: 'off'
    }

    client = new LlamaClient(args, config)
    await client.load()
    console.log('Model loaded.\n')

    const finetuneOptions = {
      trainDatasetDir: TRAIN_DATASET,
      validation: { type: 'split', fraction: 0.05 },
      numberOfEpochs: 1,
      contextLength: 1024,
      learningRate: 2e-5,
      lrMin: 1e-7,
      warmupRatioSet: true,
      warmupRatio: 0.1,
      loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
      loraRank: 32,
      assistantLossOnly: false,
      checkpointSaveSteps: 50,
      checkpointSaveDir: CHECKPOINT_DIR,
      outputParametersDir: OUTPUT_DIR
    }

    console.log('Finetune configuration:')
    console.log(`  Epochs:          ${finetuneOptions.numberOfEpochs}`)
    console.log(`  Learning rate:   ${finetuneOptions.learningRate}`)
    console.log(`  LR min:          ${finetuneOptions.lrMin}`)
    console.log(`  LoRA modules:    ${finetuneOptions.loraModules}`)
    console.log(`  Checkpoint every: ${finetuneOptions.checkpointSaveSteps} steps`)
    console.log(`  Checkpoint dir:  ${finetuneOptions.checkpointSaveDir}`)
    console.log(`  Output dir:      ${finetuneOptions.outputParametersDir}`)
    console.log('')

    console.log('Starting finetuning...\n')
    const startTime = Date.now()

    const handle = await client.finetune(finetuneOptions)
    handle.on('stats', stats => {
      console.log(`  ${formatProgress(stats, finetuneOptions.numberOfEpochs)}`)
    })

    const result = await handle.await()
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)

    console.log('\n' + '='.repeat(70))
    console.log('  Finetune complete')
    console.log('='.repeat(70))
    console.log(`  Total time:  ${elapsedSec}s`)
    console.log(`  Result:      ${JSON.stringify(result?.status || result)}`)

    if (result && typeof result.stats === 'object' && result.stats !== null) {
      console.log('  Final stats:', JSON.stringify(result.stats))
    }

    console.log(`\n  LoRA adapter saved to: ${OUTPUT_DIR}`)
    console.log('  Use this adapter with the zero-shot test to compare before/after.')
    console.log('='.repeat(70))
  } catch (error) {
    console.error('\nFinetune failed:', error.message)
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
    if (loader) {
      try {
        await loader.close()
      } catch (closeErr) {
        console.error('Failed to close loader during cleanup:', closeErr)
      }
    }
  }
}

main().catch(error => {
  console.error('\nFatal error:', error.message)
  process.exit(1)
})
