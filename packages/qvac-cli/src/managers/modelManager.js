'use strict'

const b4a = require('b4a')
const readline = require('readline')
const modelsMap = require('../../mappers/model.package.json')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const InferenceManager = require('@tetherto/qvac-lib-manager-inference')
const { getCorestoreInstance } = require('../utils/corestore')
const { ModelCache } = require('../utils/modelCache')

class QvacModelManager {
  constructor (config, storage) {
    this.config = config
    this.storage = storage
    this.hyperbeeKey = config.qvacHyperbeeKey
    this.modelCache = ModelCache.getInstance()
  }

  getModelAliasToPackageName (modelAlias) {
    if (Object.prototype.hasOwnProperty.call(modelsMap, modelAlias)) {
      return modelsMap[modelAlias]
    }
    throw new Error(`Model alias ${modelAlias} not found`)
  }

  async ready (offline = false) {
    if (!this.store) {
      const coreStore = await getCorestoreInstance(this.config)
      this.store = coreStore.namespace('models')
    }

    if (!this.swarm) {
      this.swarm = new Hyperswarm()
      this.swarm.on('connection', conn => {
        this.store.replicate(conn)
      })
    }

    const core = this.store.get({ key: b4a.from(this.hyperbeeKey, 'hex') })
    const db = new Hyperbee(core, {
      keyEncoding: 'utf-8',
      valueEncoding: 'binary'
    })

    if (offline) {
      core.ready()
    } else {
      await core.ready()
    }

    this.swarm.join(core.discoveryKey)
    if (offline) {
      this.swarm.flush().then(() => this.store.findingPeers())
    } else {
      await this.swarm.flush().then(() => this.store.findingPeers())
    }

    this.hyperbee = db
  }

  async close (inferenceManager = null) {
    if (this.swarm) {
      await this.swarm.destroy()
    }

    if (this.store) {
      await this.store.close()
    }

    if (inferenceManager) {
      await inferenceManager?._dbManager?.swarm?.destroy()
    }
  }

  async getInferenceManager (modelAlias) {
    this.store = await getCorestoreInstance(this.config)
    const config = {
      libs: [this.getModelAliasToPackageName(modelAlias)],
      hyperbeeKey: this.config.qvacHyperbeeKey,
      store: this.store
    }

    return new InferenceManager(config)
  }

  async download (modelAlias, hashKey) {
    const inferenceManager = await this.getInferenceManager(modelAlias)

    const downloadModelArgs = { name: modelAlias }
    if (hashKey) {
      downloadModelArgs.link = hashKey
    }

    const model = await inferenceManager.downloadModel(downloadModelArgs)

    this.modelCache.addModel(modelAlias)
    this.close(inferenceManager)
    return model
  }

  async load (modelAlias) {
    const inferenceManager = await this.getInferenceManager(modelAlias)
    const model = await inferenceManager.loadModel({
      name: modelAlias,
      opts: { stats: true }
    })
    return { inferenceManager, model }
  }

  async startRepl (modelAlias, { inferenceManager, model }) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'QVAC> ',
      terminal: true
    })

    const onData = (data) => {
      const userInput = data
      if (userInput.toLowerCase() === 'exit') {
        console.log('closing REPL')
        inferenceManager.unloadModel(modelAlias).then(async () => {
          await this.close(inferenceManager)
          rl.close()
          process.stdin.destroy()
          process.stdout.destroy()
        })

        return
      }

      inferenceManager.infer(userInput, { name: model })
        .then(async (response) => {
          await response.onUpdate(data => console.log(data)).await()
          rl.prompt()
        })
        .catch(err => {
          console.error(err)
          rl.prompt()
        })
    }

    rl.on('data', onData).prompt()
  }

  async listLocal () {
    const models = []
    for (const model of await this.modelCache.getModelList()) {
      models.push(model)
    }

    return models
  }

  async listRemote () {
    await this.ready()

    const models = []
    for await (const { key } of this.hyperbee.createReadStream()) {
      models.push(key)
    }

    await this.close()
    return models
  }

  async remove (modelAlias) {
    const inferenceManager = await this.getInferenceManager(modelAlias)

    try {
      await inferenceManager.deleteModels({ modelIds: modelAlias })
      this.modelCache.removeModel(modelAlias)
    } catch (error) {
      throw new Error(`Failed to remove model: ${error.message}`)
    }
  }
}

module.exports = { QvacModelManager }
