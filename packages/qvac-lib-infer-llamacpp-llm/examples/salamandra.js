'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const process = require('bare-process')
const LlmLlamacpp = require('../index')

async function main () {
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  // Create a Hyperdrive Dataloader instance for the salamandrata model
  const hdDL = new HyperDriveDL({
    key: 'hd://1610d81772a9e7c37660666dbdfdcef915b6b83c522ea1ad31c19cab0075811d',
    store: hdStore
  })

  // Salamandrata model config
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    saveWeightsToDisk: true,
    diskPath: './models/',
    modelName: 'salamandrata_2b_inst_q4.gguf'
  }

  const config = {
    gpu_layers: '99',
    ctx_size: '1024',
    device: 'gpu'
  }

  const model = new LlmLlamacpp(args, config)
  await model.load(true, console.log)

  try {
    // Example translation prompt: Italian to Spanish
    const prompt = 'Translate the following text from Italian into Spanish. \n Italian: Ciao Tether è il migliore \n Spanish:'

    const messages = [
      {
        role: 'system',
        content: prompt
      }
    ]

    const response = await model.run(messages)
    const buffer = []

    await response
      .onUpdate(data => {
        process.stdout.write(data)
        buffer.push(data)
      })
      .await()

    console.log('\n')
    console.log('Full translation:\n', buffer.join(''))
    console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
  } finally {
    await store.close()
    await model.unload()
  }
}

main().catch(error => {
  console.error('Fatal error in main function:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  })
  process.exit(1)
})
