'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const GGMLBert = require('../index')
const process = require('bare-process')

async function main () {
  console.log('Sharded Loading Example: Demonstrates loading sharded model files')
  console.log('=================================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'c3b4c8f54ac3ed3e66323e011d52c88fcb1be8596251fd5457e4faab7b062798'
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
    modelName: 'gte-large.Q2_K-00001-of-00005.gguf'
  }
  const config = '-ngl\t25'

  // 3. Loading model
  await hdDL.ready()
  const model = new GGMLBert(args, config)
  const closeLoader = true
  let totalProgress = 0
  let loadingFile = 1 // skip the tensors.txt file that is loaded first
  const reportProgressCallback = (report) => {
    if (typeof report === 'object' && Number(report.overallProgress) > totalProgress) {
      if (Number(report.filesProcessed) > loadingFile) {
        process.stdout.write('\n')
        loadingFile = Number(report.filesProcessed)
      } else {
        process.stdout.write('\r')
      }
      process.stdout.write(
        `${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
      if (Number(report.currentFileProgress) > 99.99) {
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
