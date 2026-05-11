'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')
const IdEnc = require('hypercore-id-encoding')
const os = require('os')

async function example () {
  const tmpStorage = path.join(os.tmpdir(), `qvac-registry-example-${Date.now()}`)
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('Using temporary storage:', tmpStorage)
  console.log('Registry view key:', process.env.QVAC_REGISTRY_CORE_KEY)

  // Wait for client to be ready, then log connection info
  await client.ready()
  const viewCore = client.db.core
  console.log('View core discovery key (DHT topic):', IdEnc.normalize(viewCore.discoveryKey))
  console.log('View core length:', viewCore.length)

  const allModels = await client.findModels({})
  console.log('Total models found:', allModels.length)

  const totalBytes = allModels.reduce((sum, m) => sum + (m.blobBinding?.byteLength || 0), 0)
  console.log('Total size:', totalBytes, 'bytes', (totalBytes / 1024 / 1024 / 1024).toFixed(2), 'GB')

  if (allModels.length > 0) {
    const { path: modelPath, source: modelSource } = allModels[0]
    const model = await client.getModel(modelPath, modelSource)
    console.log('Found model:', {
      ...model,
      blobBinding: model.blobBinding
        ? { ...model.blobBinding, coreKey: model.blobBinding.coreKey ? IdEnc.normalize(model.blobBinding.coreKey) : undefined }
        : undefined
    })
  }

  const modelsByEngine = await client.findModelsByEngine({
    gte: { engine: '@qvac/transcription-whispercpp' },
    lte: { engine: '@qvac/transcription-whispercpp' }
  })
  console.log('Found models by engine:', modelsByEngine.length)

  if (allModels.length > 0) {
    const modelName = allModels[0].path.split('/').pop()
    const modelsByName = await client.findModelsByName({
      gte: modelName,
      lte: modelName
    })
    console.log('Found models by name:', modelsByName.length)
  }

  const modelsByQuant = await client.findModelsByQuantization({
    gte: { quantization: 'q4_0' },
    lte: { quantization: 'q4_0' }
  })
  console.log('Found models by quantization "q4_0":', modelsByQuant.length)

  console.log('\n--- Fetching model shards by path prefix ---')

  if (allModels.length > 0) {
    const exampleModel = allModels.find(m => m.path.includes('-00001-of-') || m.path.includes('-00002-of-'))
    if (exampleModel) {
      const basePath = exampleModel.path.replace(/-\d{5}-of-\d{5}\./, '.')
      const pathPrefix = basePath.substring(0, basePath.lastIndexOf('.'))
      console.log(`Looking for all shards with path prefix: ${pathPrefix}`)

      const shards = await client.findModels({
        gte: { path: pathPrefix },
        lte: { path: pathPrefix + '\uffff' }
      })

      console.log(`Found ${shards.length} shard(s):`)
      shards.forEach(shard => {
        console.log(`  - ${shard.path} (${shard.blobBinding.byteLength} bytes)`)
      })

      const totalSize = shards.reduce((sum, shard) => sum + shard.blobBinding.byteLength, 0)
      console.log(`Total size across all shards: ${totalSize} bytes (${(totalSize / 1024 / 1024).toFixed(2)} MB)`)
    } else {
      console.log('No sharded models found in registry')
    }
  }

  console.log('\n--- Searching by non-indexed fields (client-side filtering) ---')

  const modelsBySource = allModels.filter(m => m.source === 'hf')
  console.log('Found models by source "hf":', modelsBySource.length)

  await client.close()
}

example().catch(console.error)
