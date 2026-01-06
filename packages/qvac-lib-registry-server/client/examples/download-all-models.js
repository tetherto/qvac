'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')
const os = require('os')

async function downloadAllModelsExample () {
  const tmpStorage = path.join(os.tmpdir(), `qvac-registry-download-all-${Date.now()}`)
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('Using temporary storage:', tmpStorage)
  console.log('Connected to registry...\n')

  const models = await client.findModels({})
  if (models.length === 0) {
    console.log('No models available to download.')
    await client.close()
    return
  }

  console.log(`Found ${models.length} models in registry:\n`)

  const totalSize = models.reduce((sum, m) => sum + (m.blobBinding?.byteLength || 0), 0)
  console.log(`Total download size: ${(totalSize / 1024 / 1024).toFixed(2)} MB\n`)

  const downloadDir = path.join(process.cwd(), 'downloaded')
  const results = { success: [], failed: [] }

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const progress = `[${i + 1}/${models.length}]`

    console.log(`${progress} Downloading ${model.path}...`)
    console.log(`  Engine: ${model.engine}`)
    console.log(`  Size: ${(model.blobBinding.byteLength / 1024 / 1024).toFixed(2)} MB`)

    const outputFile = path.join(downloadDir, model.engine, path.basename(model.path))

    try {
      const result = await client.downloadModel(model.path, model.source, {
        timeout: 300000,
        outputFile
      })

      results.success.push({
        path: model.path,
        outputFile: result.artifact.path,
        size: model.blobBinding.byteLength
      })

      console.log(`  ✅ Saved to: ${result.artifact.path}\n`)
    } catch (err) {
      results.failed.push({
        path: model.path,
        error: err.message
      })
      console.log(`  ❌ Failed: ${err.message}\n`)
    }
  }

  console.log('\n=== Download Summary ===')
  console.log(`Success: ${results.success.length}/${models.length}`)
  console.log(`Failed: ${results.failed.length}/${models.length}`)

  if (results.success.length > 0) {
    const downloadedSize = results.success.reduce((sum, r) => sum + r.size, 0)
    console.log(`Total downloaded: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB`)
  }

  if (results.failed.length > 0) {
    console.log('\nFailed downloads:')
    for (const f of results.failed) {
      console.log(`  - ${f.path}: ${f.error}`)
    }
  }

  await client.close()
}

downloadAllModelsExample().catch(console.error)
