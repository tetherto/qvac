'use strict'

const FilesystemDL = require('@qvac/dl-filesystem')
const GGMLBert = require('../index')
const { downloadModel } = require('./utils')

async function main () {
  console.log('Batch Inference Example: Demonstrates setting up batch inference to run multiple prompts at once')
  console.log('================================================================================================')

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
  const config = '-ngl\t25\n--batch_size\t128' // large enough batch size to run all test prompts in one pass

  // 4. Loading model
  const model = new GGMLBert(args, config)
  await model.load()

  try {
    // 5. Generating embeddings (all prompts in one batch)
    const prompts = [
      'Hello, can you suggest a game I can play with my 1 year old daughter?',
      'What is the capital of Great Britain?',
      'What is bitcoin?'
    ]
    const response = await model.run(prompts)
    const embeddings = await response.await()

    console.log('Embeddings shape:', embeddings.length, 'x', embeddings[0].length)
    console.log('First few values of first embedding:')
    console.log(embeddings[0][0].slice(0, 5))
    console.log('First few values of second embedding:')
    console.log(embeddings[0][1].slice(0, 5))
    console.log('First few values of third embedding:')
    console.log(embeddings[0][2].slice(0, 5))
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
