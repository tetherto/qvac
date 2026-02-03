'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')

const LlmLlamacpp = require('../index.js')

async function runFinetuningTests () {
  let model
  let store
  try {
    store = new Corestore('./store')

    const hdDL = new HyperDriveDL({
      key: 'hd://b11388de0e9214d8c2181eae30e31bcd49c48b26d621b353ddc7f01972dddd76',
      store
    })

    const args = {
      loader: hdDL,
      opts: { stats: true },
      logger: console,
      diskPath: './models/',
      modelName: 'Qwen3_0.6B.Q8_0.gguf'
    }

    const config = {
      gpu_layers: '999',
      ctx_size: '512',
      device: 'gpu',
      flash_attn: 'off'
    }

    model = new LlmLlamacpp(args, config)

    await hdDL.ready()
    await model.load(true, null)

    const finetuneOptions = {
      trainDatasetDir: './models/biomed.jsonl',
      evalDatasetDir: './models/biomed.jsonl',
      numberOfEpochs: 8,
      learningRate: 1e-5,
      lrMin: 1e-8,
      lrScheduler: 'cosine',
      warmupRatio: 0.1,
      contextLength: 128,
      batchSize: 128,
      microBatchSize: 128,
      loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
      assistantLossOnly: true,
      checkpointSaveSteps: 2,
      checkpointSaveDir: './lora_checkpoints',
      outputParametersDir: './finetuned-model-direct'
    }

    const finetuneResult = await model.finetune(finetuneOptions)
    console.log('Finetune completed:', finetuneResult)
  } catch (error) {
    console.error('Test failed:', error.message)
    console.error('Stack:', error.stack)
  } finally {
    if (model) {
      try {
        await model.unload()
      } catch (unloadErr) {
        console.error('Failed to unload model during cleanup:', unloadErr)
      }
    }
    if (store) {
      try {
        await store.close()
      } catch (storeErr) {
        console.error('Failed to close store during cleanup:', storeErr)
      }
    }
  }
}

runFinetuningTests().catch(console.error)
