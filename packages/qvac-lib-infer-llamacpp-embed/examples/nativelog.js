'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const GGMLBert = require('../index.js')
const process = require('bare-process')
const { setLogger, releaseLogger } = require('../addonLogging.js')

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

  // 2. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'd1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 3. Configuring model settings
  const args = {
    loader: hdDL,
    logger: console,
    opts: { stats: true },
    diskPath: './models',
    modelName: 'gte-large_fp16.gguf'
  }
  const config = '-ngl\t25\nverbosity\t2'

  // 4. Loading model
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
    await hdDL.close()
    await store.close()
    releaseLogger()
  }
}

main().catch(console.error)
