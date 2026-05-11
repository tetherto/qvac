'use strict'

const path = require('bare-path')
const GGMLBert = require('../index')
const { downloadModel } = require('./utils')

async function main () {
  console.log('Quickstart Example: Basic model loading and inference demonstration')
  console.log('===================================================================')

  // 1. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
    'gte-large_fp16.gguf'
  )

  // 2. Configuring model settings
  const model = new GGMLBert({
    files: { model: [path.join(dirPath, modelName)] },
    config: { device: 'gpu', gpu_layers: '25' },
    logger: console,
    opts: { stats: true }
  })

  // 3. Loading model
  await model.load()

  try {
    // 4. Generating embeddings
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
    // 5. Cleaning up resources
    await model.unload()
  }
}

main().catch(console.error)
