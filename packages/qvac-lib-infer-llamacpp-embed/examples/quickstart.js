'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const GGMLBert = require('../index')
const process = require('bare-process')

async function main () {
  console.log('Quickstart Example: Basic model loading and inference demonstration')
  console.log('===================================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'd1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 2. Configuring model settings
  const args = {
    loader: hdDL,
    logger: console,
    opts: { stats: true },
    diskPath: './models',
    modelName: 'gte-large_fp16.gguf'
  }
  const config = '-ngl\t25'

  // 3. Loading model
  await hdDL.ready()
  const model = new GGMLBert(args, config)
  const closeLoader = true
  let totalProgress = 0
  const reportProgressCallback = (report) => {
    if (typeof report === 'object' && Number(report.overallProgress) > totalProgress) {
      process.stdout.write(
        `\r${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
      if (Number(report.currentFileProgress) === 100) {
        process.stdout.write('\n')
      }
      totalProgress = Number(report.overallProgress)
    }
  }
  await model.load(closeLoader, reportProgressCallback)

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
    await hdDL.close()
    await store.close()
  }
}

main().catch(console.error)
