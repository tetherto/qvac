'use strict'

const path = require('bare-path')
const GGMLBert = require('../index.js')
const { setLogger, releaseLogger } = require('../addonLogging.js')
const { downloadModel } = require('./utils')

async function main () {
  console.log('Native Logger Example: C++ logging demonstration')
  console.log('================================================')

  // 1. Setting up C++ logger
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
  console.log('Now demonstrating actual C++ logging during addon usage...\n')

  // 2. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
    'gte-large_fp16.gguf'
  )

  // 3. Configuring model settings
  const model = new GGMLBert({
    files: { model: [path.join(dirPath, modelName)] },
    config: { device: 'gpu', gpu_layers: '25', verbosity: '2' },
    logger: console,
    opts: { stats: true }
  })

  // 4. Loading model
  await model.load()

  try {
    // 5. Generating embeddings
    const query = 'Hello, can you suggest a game I can play with my 1 year old daughter?'
    const response = await model.run(query)
    const embeddings = await response.await()

    console.log('Embeddings shape:', embeddings.length, 'x', embeddings[0].length)
    console.log('First few values of first embedding:')
    console.log(embeddings[0].slice(0, 5))
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

main().catch(console.error)
