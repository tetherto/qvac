'use strict'

const path = require('path')
const fs = require('fs')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')

async function downloadAllModelsExample () {
  const tmpStorage = path.join(process.cwd(), '.cache', `registry-${Date.now()}`)
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
  const results = { success: [], failed: [], skipped: [] }

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const progress = `[${i + 1}/${models.length}]`

    const quantDir = model.quantization || 'default'
    const outputFile = path.join(downloadDir, model.engine, quantDir, path.basename(model.path))

    try {
      const expectedSize = model.blobBinding?.byteLength || 0
      let stats = null

      try {
        stats = await fs.promises.stat(outputFile)
      } catch {
        // File doesn't exist, proceed to download
      }

      if (stats) {
        const sizeMatch = stats.size === expectedSize

        if (sizeMatch) {
          results.skipped.push({
            path: model.path,
            outputFile,
            size: stats.size
          })
          console.log(`${progress} Skipping ${model.path} (already exists)`)
          console.log(`  Engine: ${model.engine}`)
          console.log(`  Size: ${(expectedSize / 1024 / 1024).toFixed(2)} MB`)
          console.log(`  ⏭️  File exists: ${outputFile}\n`)
          continue
        } else {
          console.log(`${progress} Removing incomplete file ${model.path}`)
          console.log(`  Expected: ${(expectedSize / 1024 / 1024).toFixed(2)} MB, Found: ${(stats.size / 1024 / 1024).toFixed(2)} MB`)
          await fs.promises.unlink(outputFile)
        }
      }

      console.log(`${progress} Downloading ${model.path}...`)
      console.log(`  Engine: ${model.engine}`)
      console.log(`  Size: ${(expectedSize / 1024 / 1024).toFixed(2)} MB`)

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
  console.log(`Skipped: ${results.skipped.length}/${models.length}`)
  console.log(`Failed: ${results.failed.length}/${models.length}`)

  if (results.success.length > 0) {
    const downloadedSize = results.success.reduce((sum, r) => sum + r.size, 0)
    console.log(`Total downloaded: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB`)
  }

  if (results.skipped.length > 0) {
    const skippedSize = results.skipped.reduce((sum, r) => sum + r.size, 0)
    console.log(`Total skipped: ${(skippedSize / 1024 / 1024).toFixed(2)} MB`)
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
