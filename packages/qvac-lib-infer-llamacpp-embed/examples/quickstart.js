'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const GGMLBert = require('../index.js')

async function main () {
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
  const config = '-ngl\t25\n--batch_size\t1024' // Set context size to 2048 for batching
  const model = new GGMLBert(args, config)

  await model.load(true)

  try {
    const query = ['Hello', 'World']
    // 'Hello, can you suggest a game I can play with my 1 year old daughter?'

    const response = await model.run(query)

    const embeddings = await response.await()

    console.log('Embeddings shape:', embeddings.length, 'x',
      embeddings[0].length)
    console.log('First few values of first embedding:')
    console.log(embeddings[0].slice(0, 5))
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    await model.unload()
    await store.close()
  }
}

main().catch(console.error)
