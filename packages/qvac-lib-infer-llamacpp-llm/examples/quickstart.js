'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const process = require('bare-process')

async function main () {
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    diskPath: './models'
  }

  const config = {
    device: 'gpu',
    // Force GPU: (very large number of gpu-layers)
    gpu_layers: '999',
    ctx_size: '1024'
  }

  await hdDL.ready()
  const model = new LlmLlamacpp(args, config)
  const closeLoader = true
  const reportProgressCallback = (report) => {
    if (typeof report === 'object') {
      console.log(
        `${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
    }
  }
  await model.load(closeLoader, reportProgressCallback)

  try {
    const prompt = [
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        content: 'what is bitcoin?'
      },
      {
        role: 'assistant',
        content: "It's a digital currency."
      },
      {
        role: 'user',
        content: 'Can you elaborate on the previous topic?'
      }
    ]

    const response = await model.run(prompt)
    let fullResponse = ''

    await response
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse)
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
