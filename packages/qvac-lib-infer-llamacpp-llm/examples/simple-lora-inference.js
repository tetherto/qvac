'use strict'

const LlamaClient = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const process = require('bare-process')
const path = require('bare-path')

async function main () {
  const baseModelPath = './models/Qwen3_0.6B.Q8_0.gguf'
  const loraAdapterPath = './lora_checkpoints/checkpoint_step_00000006/model.gguf'

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
    ctx_size: '4096',
    temp: '0.0',
    n_predict: '256',
    lora: loraAdapterPath
  }

  let client
  try {
    client = new LlamaClient(args, config)
    await client.load()

    const messages = [
      { role: 'system', content: 'You are a helpful healthcare assistant.' },
      {
        role: 'user',
        content: "Do nurses' involvement in patient education improve outcomes?"
      }
    ]

    const response = await client.run(messages)
    await response.onUpdate(token => {
      process.stdout.write(token)
    }).await()
  } finally {
    if (client) {
      console.log('\n Cleaning up...')
      await client.unload()
      console.log(' Done!')
    }
  }
}

main().catch(async error => {
  console.error('\n Fatal error in LoRA demo:', error.message)
  process.exit(1)
})
