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

  // an example of possible configuration
  const config = {
    gpu_layers: '99', // number of model layers offloaded to GPU.
    ctx_size: '2048', // context length
    device: 'gpu'
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
        role: 'session',
        content: 'cache0.bin'
      },
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
        content: 'what is this file about?'
      }
    ]

    console.log('\n\n')
    const response = await model.run(messages1)
    const buffer = []
    await response
      .onUpdate(data => {
        process.stdout.write(data)
        buffer.push(data)
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', buffer.join(''))
    console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    console.log('\n')

    // 7. Second inference with image file path
    const messages2 = [
      {
        role: 'user',
        content: 'what i asked you before? answer shortly'
      }
    ]

    console.log('\n\n')
    const response2 = await model.run(messages2)
    const buffer2 = []

    await response2
      .onUpdate(data => {
        process.stdout.write(data)
        buffer2.push(data)
      })
      .await()

    const messages3 = [
      {
        role: 'session',
        content: 'cache1.bin'
      },
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
        content: 'what is this file about?'
      }
    ]

    console.log('\n\n')
    const response3 = await model.run(messages3)
    const buffer3 = []

    await response3
      .onUpdate(data => {
        process.stdout.write(data)
        buffer3.push(data)
      })
      .await()

    const messages4 = [
      {
        role: 'session',
        content: 'cache0.bin'
      },
      {
        role: 'user',
        content: 'what i asked you before? answer shortly'
      }
    ]

    console.log('\n\n')
    const response4 = await model.run(messages4)
    const buffer4 = []

    await response4
      .onUpdate(data => {
        process.stdout.write(data)
        buffer4.push(data)
      })
      .await()

    console.log('\n')
  } finally {
    // 8. Cleaning up resources
    await model.unload()
    await fsDL.close()
  }
}

main().catch(console.error)
