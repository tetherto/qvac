'use strict'

const GGMLBert = require('../../index')
const config = require('./example.config.json')
const FilesystemDL = require('@qvac/dl-filesystem')
const path = require('bare-path')

async function main () {
  const compiledModelsPath = path.join(__dirname, '../../model/gte-large')
  const pathToYourModelFile = path.join(compiledModelsPath, 'gte-large.so')

  const hdDL = new FilesystemDL({ dirPath: compiledModelsPath })
  const args = {
    loader: hdDL,
    opts: {}
  }
  const model = new GGMLBert(args, {
    ...config,
    modelFilePath: pathToYourModelFile
  })
  await model.load()
  try {
    const query =
      'Hello, can you suggest a game I can play with my 1 year old daughter?'

    const embeddings = await model.run(query)

    console.log('Embeddings shape:', embeddings.length, 'x', embeddings[0].length)
    console.log('First few values of first embedding:')
    console.log(embeddings[0].slice(0, 5))
  } finally {
    await model.unload()
  }
}

main().catch(console.error)
