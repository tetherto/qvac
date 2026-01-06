'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')

// 1. Import the LlmLlamacpp class
const LlmLlamacpp = require('../index')
const { setLogger, releaseLogger } = require('../addonLogging')

const process = require('bare-process')

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

  const store = new Corestore('./store')

  // 2. Create a Hyperdrive Data Loader
  const hdDL = new HyperDriveDL({
    key: 'hd://b11388de0e9214d8c2181eae30e31bcd49c48b26d621b353ddc7f01972dddd76',
    store
  })

  // 3. Configure the `args` object
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    // saveWeightsToDisk: true, this is the default usage until we implement load method in addon.
    diskPath: './models/',
    modelName: 'medgemma-4b-it-Q4_1.gguf'
  }

  // 4. Create the `config` object
  // an example of possible configuration
  const config = {
    gpu_layers: '99', // number of model layers offloaded to GPU.
    ctx_size: '1024', // context length
    device: 'gpu' // must be specified: 'gpu' or 'cpu'
  }

  // 5. Create Model instance
  const model = new LlmLlamacpp(args, config)

  // 6. Load Model
  await model.load()

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
    // 8. Release Resources
    await store.close()
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
