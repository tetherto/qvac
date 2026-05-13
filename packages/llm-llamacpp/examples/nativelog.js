'use strict'

const LlmLlamacpp = require('../index')
const { setLogger, releaseLogger } = require('../addonLogging')
const path = require('bare-path')
const process = require('bare-process')
const { downloadModel } = require('./utils')

async function main () {
  console.log('Native Logging Example: Demonstrates C++ addon logging integration')
  console.log('==================================================================')

  // 1. Setting up C++ logger - must be done before creating any addon instances
  console.log('Setting up C++ logger...')

  setLogger((priority, message) => {
    const priorityNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG'
    }

    const priorityName = priorityNames[priority] || 'UNKNOWN'
    const timestamp = new Date().toISOString()

    console.log(`[${timestamp}] [C++ TEST] [${priorityName}]: ${message}`)
  })

  console.log('Logger setup complete. C++ logging is now active.')
  console.log('Now creating addon instances...\n')

  // 2. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
    'Llama-3.2-1B-Instruct-Q4_0.gguf'
  )

  // 3. Configuring model settings
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: 'gpu',
    gpu_layers: '99',
    ctx_size: '1024',
    verbosity: '2'
  }

  // 4. Loading model
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })
  await model.load()

  try {
    // 5. Running inference with conversation prompt
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
    // 6. Cleaning up resources
    await model.unload()
    releaseLogger()
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
