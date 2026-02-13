'use strict'

const FilesystemDL = require('@qvac/dl-filesystem')
const GGMLBert = require('../index.js')
const { downloadModel } = require('./utils')

async function main () {
  console.log('Filesystem Example: Demonstrates model loading from the file system')
  console.log('===================================================================')

  // 1. Setting up filesystem data loader
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
    'gte-large_fp16.gguf'
  )

  const fsDL = new FilesystemDL({ dirPath })

  // 2. Configuring model settings
  const args = {
    loader: fsDL,
    opts: { stats: true },
    logger: console,
    diskPath: dirPath,
    modelName
  }
  const config = '-ngl\t25'

  // 3. Loading model
  const model = new GGMLBert(args, config)
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
    await fsDL.close()
  }
}

main().catch(console.error)
