'use strict'

const LlmLlamacpp = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const { setLogger, releaseLogger } = require('../addonLogging')
const process = require('bare-process')
const { downloadModel } = require('./utils')

async function main () {
  console.log('=== C++ Logger Example ===')

  // IMPORTANT: Set up the logger FIRST, before creating any addon instances
  console.log('Setting up C++ logger...')

  setLogger((priority, message) => {
    const priorityNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG',
      4: 'OFF'
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

  // 3. Initializing data loader
  const fsDL = new FilesystemDL({ dirPath })

  // 4. Configuring model settings
  const args = {
    loader: fsDL,
    opts: { stats: true },
    logger: console,
    diskPath: dirPath,
    modelName
  }

  // 4. Create the `config` object
  // an example of possible configuration
  const config = {
    gpu_layers: '99', // number of model layers offloaded to GPU.
    ctx_size: '1024', // context length
    device: 'gpu' // must be specified: 'gpu' or 'cpu'
  }

  // 5. Loading model
  const model = new LlmLlamacpp(args, config)
  await model.load()

  try {
    // 6. Running inference with conversation prompt
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

    // 7. Run Inference
    const response = await model.run(prompt)
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
  } finally {
    // 7. Cleaning up resources
    await model.unload()
    await fsDL.close()
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
