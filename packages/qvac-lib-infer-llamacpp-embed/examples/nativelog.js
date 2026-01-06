'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const GGMLBert = require('../index.js')
const { setLogger } = require('../addon')

async function main () {
  console.log('=== C++ Logger Example ===')

  // Set up the logger to receive messages from C++
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

  const store = new Corestore('./store')

  const hdDL = new HyperDriveDL({
    key: 'hd://d1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e',
    store
  })

  const args = {
    loader: hdDL,
    logger: console,
    opts: { stats: true },
    diskPath: './models/',
    modelName: 'gte-large_fp16.gguf'
  }
  const config = '-ngl\t25'
  const model = new GGMLBert(args, config)

  await model.load(true)

  try {
    const query =
      'Hello, can you suggest a game I can play with my 1 year old daughter?'

    const response = await model.run(query)

    const embeddings = await response.await()

    console.log(
      'Embeddings shape:',
      embeddings.length,
      'x',
      embeddings[0].length
    )
    console.log('First few values of first embedding:')
    console.log(embeddings[0].slice(0, 5))
  } finally {
    await model.unload()
    await store.close()
  }
}

main().catch(console.error)
