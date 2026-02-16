'use strict'

const FilesystemDL = require('@qvac/dl-filesystem')
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

  // 2. Initializing data loader
  const fsDL = new FilesystemDL({ dirPath })

  // 3. Configuring model settings
  const args = {
    loader: fsDL,
    logger: console,
    opts: { stats: true },
    diskPath: dirPath,
    modelName
  }
  const config = '-ngl\t25'

  // 4. Loading model
  const model = new GGMLBert(args, config)
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
    await fsDL.close()
  }
}

main().catch(console.error)
