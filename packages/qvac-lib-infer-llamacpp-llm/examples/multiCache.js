'use strict'

const LlmLlamacpp = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const process = require('bare-process')
const { downloadModel } = require('./utils')

async function main () {
  console.log('Multi-Cache Example: Demonstrates cache management with multiple cache files')
  console.log('============================================================================')

  // 1. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
    'Llama-3.2-1B-Instruct-Q4_0.gguf'
  )

  // 2. Initializing data loader
  const fsDL = new FilesystemDL({ dirPath })

  // 3. Configuring model settings
  const args = {
    loader: fsDL,
    opts: { stats: true },
    logger: console,
    diskPath: dirPath,
    modelName
  }

  const config = {
    device: 'gpu',
    gpu_layers: '99',
    ctx_size: '10000'
  }

  // 4. Loading model
  const model = new LlmLlamacpp(args, config)
  await model.load()

  try {
    // 5. First conversation - no cache will be used. One shot inference
    const messages = [
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
        content: 'Can you elaborate on the previous topic? No more than 10 lines.'
      }
    ]

    const response1 = await model.run(messages)
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

    // 6. Switching to a new session with cache1.bin file
    const messages2 = [
      {
        role: 'session',
        content: 'cache1.bin'
      },
      {
        role: 'user',
        content: 'what is bitcoin?'
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

    // 7. Continuing conversation with cache1.bin
    const messages3 = [
      {
        role: 'session',
        content: 'cache1.bin'
      },
      {
        role: 'user',
        content: 'can you elaborate on the previous topic?'
      }
    ]

    const response3 = await model.run(messages3)
    let fullResponse3 = ''

    await response3
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse3 += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse3)
    console.log(`Inference stats: ${JSON.stringify(response3.stats)}`)
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
