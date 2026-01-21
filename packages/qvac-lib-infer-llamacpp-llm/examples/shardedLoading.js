'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const process = require('bare-process')

async function main () {
  console.log('Sharded Loading Example: Demonstrates loading sharded model files')
  console.log('=================================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')
  const hdKey = process.env.MODEL_HD_KEY || '1839dcabe1df8fdf1c83cd3d7a306c6e01e3c67e8542b0dd1e78cdfc86e75e2d'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 2. Configuring model settings
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    modelName: process.env.MODEL_NAME || 'medgemma-4b-it-Q4_1-00001-of-00005.gguf',
    diskPath: './models'
  }

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '1024'
  }

  // 3. Loading sharded model
  await hdDL.ready()
  const model = new LlmLlamacpp(args, config)
  const closeLoader = true
  let totalProgress = 0
  let loadingFile = 1 // skip the tensors.txt file that is loaded first
  const reportProgressCallback = (report) => {
    if (typeof report === 'object' && Number(report.overallProgress) > totalProgress) {
      if (Number(report.filesProcessed) > loadingFile) {
        process.stdout.write('\n')
        loadingFile = Number(report.filesProcessed)
      } else {
        process.stdout.write('\r')
      }
      process.stdout.write(
        `${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
      if (Number(report.currentFileProgress) > 99.99) {
        process.stdout.write('\n')
      }
      totalProgress = Number(report.overallProgress)
    }
  }
  await model.load(closeLoader, reportProgressCallback)

  try {
    // 4. Running inference with conversation prompt
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
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 5. Cleaning up resources
    await store.close()
    await hdDL.close()
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
