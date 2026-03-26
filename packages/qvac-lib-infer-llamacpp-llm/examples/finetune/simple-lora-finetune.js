'use strict'

const LlmLlamacpp = require('../../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const { downloadModel, formatProgress, createFilteredLogger } = require('../utils')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

async function runFinetuningTests () {
  let model
  let loader

  const { logger: filteredLogger, restore: restoreConsole } = createFilteredLogger()

  try {
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
    restoreConsole()

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
