'use strict'

const GGMLBert = require('../index')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')

async function main () {
  const store = new Corestore('./store')
  const dbStore = store.namespace('db')
  const swarm = new Hyperswarm()

  swarm.on('connection', conn => {
    dbStore.replicate(conn)
  })

  const core = dbStore.get({
    key: Buffer.from(
      '6d15c77f4bbfbe61f761307faa07a2657a5e5060e1d2336bf16fb8074e662fb3',
      'hex'
    )
  })

  await core.ready()
  const foundPeers = dbStore.findingPeers()
  swarm.join(core.discoveryKey)
  swarm.flush().then(() => foundPeers())

  const hdStore = store.namespace('hd')
  const hdDL = new HyperDriveDL({
    key: 'hd://c3b4c8f54ac3ed3e66323e011d52c88fcb1be8596251fd5457e4faab7b062798',
    logger: console,
    store: hdStore
  })
  await hdDL.ready()

  const config = '-ngl\t25'
  const args = {
    modelName: 'gte-large.Q2_K-00001-of-00005.gguf',
    logger: console,
    loader: hdDL,
    // Already saved to ./store, avoid duplicating in disk twice.
    // If store already exists it will not download from network again.
    // Note: This option is no longer needed/used by the JS classes,
    // even though it might appear on other examples.
    // saveWeightsToDisk: false,
    opts: {}
  }
  const model = new GGMLBert(args, config)
  const closeLoader = true
  const reportProgressCallback = (report) => {
    if (typeof report === 'object') {
      console.log(
        `${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
    }
  }
  await model.load(closeLoader, reportProgressCallback)

  try {
    const query =
      'Hello, can you suggest a game I can play with my 1 year old daughter?'

    const response = await model.run(query)
    const embeddings = await response._finishPromise

    console.log(embeddings[0][0])
  } finally {
    await model.destroy()
    await hdDL._close()
    await store.close()
    await swarm.destroy()
  }
}

main()
