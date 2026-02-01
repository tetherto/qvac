'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')
const os = require('os')

async function downloadModelExample () {
  const tmpStorage = path.join(os.tmpdir(), `qvac-registry-download-${Date.now()}`)
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('Using temporary storage:', tmpStorage)

  console.log('Connected to registry...\n')

  const models = await client.findModels({})
  if (models.length === 0) {
    console.log('No models available to download.')
    return
  }

  const targetModel = models[0]
  console.log(`Downloading ${targetModel.path} (${targetModel.engine})...`)

  const outputFile = path.join(process.cwd(), 'downloaded', path.basename(targetModel.path))

  const result = await client.downloadModel(targetModel.path, targetModel.source, {
    timeout: 60000,
    peerTimeout: 15000,
    outputFile
  })

  console.log('\n✅ Model downloaded successfully!')
  console.log('Model metadata:', result.model)
  console.log('Artifact saved to:', result.artifact.path)

  await client.close()
}

downloadModelExample().catch(console.error)
