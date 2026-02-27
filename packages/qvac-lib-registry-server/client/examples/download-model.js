'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')
const os = require('os')

async function downloadModelExample () {
  const t0 = Date.now()

  const tmpStorage = path.join(os.tmpdir(), `qvac-registry-download-${Date.now()}`)
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('Using temporary storage:', tmpStorage)
  console.log('Waiting for client.ready() (includes metadata core sync)...')

  await client.ready()
  const tReady = Date.now()
  console.log(`[TIMING] client.ready() took ${tReady - t0}ms\n`)

  const models = await client.findModels({})
  const tQuery = Date.now()
  console.log(`[TIMING] findModels query took ${tQuery - tReady}ms`)

  if (models.length === 0) {
    console.log('No models available to download.')
    return
  }

  const targetModel = models[0]
  console.log(`Downloading ${targetModel.path} (${targetModel.engine})...`)

  const outputFile = path.join(process.cwd(), 'downloaded', path.basename(targetModel.path))

  const tDownloadStart = Date.now()
  const result = await client.downloadModel(targetModel.path, targetModel.source, {
    timeout: 60000,
    peerTimeout: 15000,
    outputFile
  })
  const tDone = Date.now()

  console.log('\nModel downloaded successfully!')
  console.log('Artifact saved to:', result.artifact.path)

  console.log('\n--- Timing Summary ---')
  console.log(`client.ready() (metadata core sync): ${tReady - t0}ms`)
  console.log(`findModels query:                    ${tQuery - tReady}ms`)
  console.log(`downloadModel (lookup + transfer):   ${tDone - tDownloadStart}ms`)
  console.log(`Total wall time:                     ${tDone - t0}ms`)

  await client.close()
}

downloadModelExample().catch(console.error)
