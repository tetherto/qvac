'use strict'

const LlmLlamacpp = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const fs = require('bare-fs')
const process = require('bare-process')
const { downloadModel } = require('./utils')

async function main () {
  console.log('Multimodal Example: Demonstrates file processing capabilities')
  console.log('=============================================================')

  // 1. Downloading models (LLM and projection model)
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    'SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  )

  const [projectionModel] = await downloadModel(
    'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  )

  // 2. Initializing data loader
  const fsDL = new FilesystemDL({ dirPath })

  // 3. Configuring model settings
  const args = {
    loader: fsDL,
    opts: { stats: true },
    logger: console,
    diskPath: dirPath,
    modelName,
    projectionModel
  }

  const config = {
    device: 'gpu',
    gpu_layers: '99',
    ctx_size: '2048'
  }

  // 4. Loading model
  const model = new LlmLlamacpp(args, config)
  await model.load()

  // 5. Preparing media. We will use both the path and the buffer in different inferences
  const imageFilePath = 'media/news-paper.jpg'
  const imageBuffer = new Uint8Array(fs.readFileSync(imageFilePath))

  try {
    // 6. First inference with image buffer
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

    // 7. Second inference with image file path
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
    // 8. Cleaning up resources
    await model.unload()
    await fsDL.close()
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
