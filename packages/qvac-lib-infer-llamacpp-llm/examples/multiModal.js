'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const fs = require('bare-fs')
const process = require('bare-process')

async function main () {
  console.log('Multimodal Example: Demonstrates file processing capabilities')
  console.log('=============================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = '73b1bc01d01e25fa27be7d7f434337d14f054b0315e8463766ca31e778ac6576'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 2. Configuring model settings
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    modelName: 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    projectionModel: 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    diskPath: './models'
  }

  const config = {
    device: 'gpu',
    gpu_layers: '99',
    ctx_size: '2048'
  }

  // 3. Loading model
  await hdDL.ready()
  const model = new LlmLlamacpp(args, config)
  const closeLoader = true
  let totalProgress = 0
  const reportProgressCallback = (report) => {
    if (typeof report === 'object' && Number(report.overallProgress) > totalProgress) {
      process.stdout.write(
        `\r${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
      if (Number(report.currentFileProgress) === 100) {
        process.stdout.write('\n')
      }
      totalProgress = Number(report.overallProgress)
    }
  }
  await model.load(closeLoader, reportProgressCallback)

  // 4. Preparing media. We will use both the path and the buffer in different inferences
  const imageFilePath = 'media/news-paper.jpg'
  const imageBuffer = new Uint8Array(fs.readFileSync(imageFilePath))

  try {
    // 5. First inference with image buffer
    const messages1 = [
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        type: 'media',
        content: imageBuffer
      },
      {
        role: 'user',
        content: 'what is in the image?'
      }
    ]

    const response1 = await model.run(messages1)
    let fullResponse1 = ''

    await response1
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse1 += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse1)
    console.log(`Inference stats: ${JSON.stringify(response1.stats)}`)
    console.log('\n')

    // 6. Second inference with image file path
    const messages2 = [
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        type: 'media',
        content: imageFilePath
      },
      {
        role: 'user',
        content: 'what is in the image?'
      }
    ]

    const response2 = await model.run(messages2)
    let fullResponse2 = ''

    await response2
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse2 += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse2)
    console.log(`Inference stats: ${JSON.stringify(response2.stats)}`)
    console.log('\n')
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 7. Cleaning up resources
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
