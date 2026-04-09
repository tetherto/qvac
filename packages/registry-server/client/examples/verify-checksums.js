'use strict'

/**
 * Verify SHA256 checksums of downloaded model files against registry metadata.
 *
 * Usage: node verify-checksums.js [download-dir]
 *
 * Arguments:
 *   download-dir  Path to downloaded models directory (default: ./downloaded)
 *
 * Exit codes:
 *   0 - All checksums verified successfully
 *   1 - One or more checksum mismatches found
 */

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')

/**
 * Compute SHA256 hash of a file using streaming
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} Hex-encoded SHA256 hash
 */
async function computeSha256 (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)

    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Format bytes as human-readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatSize (bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function verifyChecksums () {
  const downloadDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.cwd(), 'downloaded')

  const tmpStorage = path.join(process.cwd(), '.cache', `registry-verify-${Date.now()}`)
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('Connecting to registry...')
  console.log('Download directory:', downloadDir)

  const models = await client.findModels({})
  console.log(`Found ${models.length} models in registry\n`)

  const results = {
    verified: [],
    mismatch: [],
    missing: [],
    noChecksum: []
  }

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const progress = `[${i + 1}/${models.length}]`
    const expectedSha256 = model.blobBinding?.sha256
    const quantDir = model.quantization || 'default'
    const outputFile = path.join(downloadDir, model.engine, quantDir, path.basename(model.path))

    if (!expectedSha256) {
      results.noChecksum.push({ path: model.path, outputFile })
      console.log(`${progress} ⚠️  No checksum: ${model.path}`)
      continue
    }

    let stats = null
    try {
      stats = await fs.promises.stat(outputFile)
    } catch {
      results.missing.push({
        path: model.path,
        outputFile,
        expectedSha256
      })
      console.log(`${progress} ⏭️  Missing: ${path.basename(model.path)}`)
      continue
    }

    console.log(`${progress} Verifying ${path.basename(model.path)} (${formatSize(stats.size)})...`)

    try {
      const actualSha256 = await computeSha256(outputFile)

      if (actualSha256 === expectedSha256) {
        results.verified.push({
          path: model.path,
          outputFile,
          sha256: actualSha256,
          size: stats.size
        })
        console.log('       ✅ Checksum OK')
      } else {
        results.mismatch.push({
          path: model.path,
          outputFile,
          expected: expectedSha256,
          actual: actualSha256,
          size: stats.size
        })
        console.log('       ❌ MISMATCH!')
        console.log(`          Expected: ${expectedSha256}`)
        console.log(`          Actual:   ${actualSha256}`)
      }
    } catch (err) {
      results.mismatch.push({
        path: model.path,
        outputFile,
        error: err.message
      })
      console.log(`       ❌ Error: ${err.message}`)
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('VERIFICATION SUMMARY')
  console.log('='.repeat(60))
  console.log(`✅ Verified:     ${results.verified.length}`)
  console.log(`❌ Mismatch:     ${results.mismatch.length}`)
  console.log(`⏭️  Missing:      ${results.missing.length}`)
  console.log(`⚠️  No checksum:  ${results.noChecksum.length}`)
  console.log(`📦 Total models: ${models.length}`)

  if (results.verified.length > 0) {
    const verifiedSize = results.verified.reduce((sum, r) => sum + r.size, 0)
    console.log(`\nVerified data: ${formatSize(verifiedSize)}`)
  }

  if (results.mismatch.length > 0) {
    console.log('\n' + '-'.repeat(60))
    console.log('CHECKSUM MISMATCHES (need re-download):')
    console.log('-'.repeat(60))
    for (const m of results.mismatch) {
      console.log(`  ${m.path}`)
      if (m.error) {
        console.log(`    Error: ${m.error}`)
      } else {
        console.log(`    Expected: ${m.expected}`)
        console.log(`    Actual:   ${m.actual}`)
      }
    }
  }

  if (results.missing.length > 0) {
    console.log('\n' + '-'.repeat(60))
    console.log('MISSING FILES:')
    console.log('-'.repeat(60))
    for (const m of results.missing) {
      console.log(`  ${m.path}`)
    }
  }

  await client.close()

  try {
    await fs.promises.rm(tmpStorage, { recursive: true })
  } catch {
    // Ignore cleanup errors
  }

  if (results.mismatch.length > 0) {
    process.exit(1)
  }
}

verifyChecksums().catch((err) => {
  console.error('Verification failed:', err.message)
  process.exit(1)
})
