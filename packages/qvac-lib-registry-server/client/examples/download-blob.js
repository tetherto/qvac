'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')
const os = require('os')

// ggml-tiny-q8_0.bin from output.json (~43MB, 665 blocks)
const WHISPER_TINY_Q8 = {
  coreKey: 'ey46cahego89xox118uhyryakz47bcs8bbxu97tnnpmuwmgi5wmo',
  blockOffset: 0,
  blockLength: 665,
  byteOffset: 0,
  byteLength: 43537433,
  sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca'
}

async function downloadBlobExample () {
  const t0 = Date.now()

  const tmpStorage = path.join(os.tmpdir(), `qvac-registry-blob-${Date.now()}`)
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('Using temporary storage:', tmpStorage)
  console.log('Waiting for client.ready() (includes metadata core sync)...')

  await client.ready()
  const tReady = Date.now()
  console.log(`[TIMING] client.ready() took ${tReady - t0}ms`)

  const outputFile = path.join(process.cwd(), 'downloaded', 'ggml-tiny-q8_0.bin')

  console.log(`\nDownloading blob directly (${(WHISPER_TINY_Q8.byteLength / 1024 / 1024).toFixed(1)} MB)...`)
  const tDownloadStart = Date.now()

  const result = await client.downloadBlob(WHISPER_TINY_Q8, {
    timeout: 60000,
    outputFile
  })

  const tDone = Date.now()

  console.log('\nArtifact saved to:', result.artifact.path)
  console.log(`Total size: ${(result.artifact.totalSize / 1024 / 1024).toFixed(1)} MB`)

  console.log('\n--- Timing Summary ---')
  console.log(`client.ready() (metadata core sync): ${tReady - t0}ms`)
  console.log(`Blob download:                       ${tDone - tDownloadStart}ms`)
  console.log(`Total wall time:                     ${tDone - t0}ms`)

  await client.close()
}

downloadBlobExample().catch(console.error)
