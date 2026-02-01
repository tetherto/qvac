'use strict'

const path = require('path')
const fsPromises = require('fs').promises
const { URL } = require('url')
const { pipeline } = require('stream/promises')
const { createWriteStream } = require('fs')
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { downloadFileToCacheDir } = require('@huggingface/hub')
const { extractGGUFMetadata, isGGUFSource } = require('../lib/gguf-helpers')
const logger = require('../lib/logger')
const RegistryConfig = require('../lib/config')

async function testGGUFExtraction () {
  const args = process.argv.slice(2)
  let modelsFile = './data/models.prod.json'
  let modelIndex = null
  let limit = null
  let skip = 0
  let startFrom = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--models-file' || args[i] === '-f') {
      modelsFile = args[++i]
    } else if (args[i] === '--model') {
      modelIndex = parseInt(args[++i], 10)
    } else if (args[i] === '--limit') {
      limit = parseInt(args[++i], 10)
    } else if (args[i] === '--skip') {
      skip = parseInt(args[++i], 10)
    } else if (args[i] === '--start-from') {
      startFrom = args[++i]
    }
  }

  const modelsPath = path.resolve(modelsFile)
  const modelsData = JSON.parse(await fsPromises.readFile(modelsPath, 'utf8'))

  if (!Array.isArray(modelsData)) {
    logger.error(`${modelsFile} must contain an array of model definitions`)
    process.exit(1)
  }

  const ggufModels = modelsData
    .map((model, index) => ({ ...model, index }))
    .filter(model => isGGUFSource(model.source))

  if (ggufModels.length === 0) {
    logger.info('No GGUF models found in test file')
    process.exit(0)
  }

  logger.info(`Found ${ggufModels.length} GGUF model(s) in test file`)

  // Filter sharded models - only keep first shard (maintain order)
  const shardGroups = new Map()
  const filteredModels = []
  let skippedShards = 0

  for (const model of ggufModels) {
    const shardInfo = detectShard(model.source)
    if (shardInfo) {
      const key = shardInfo.baseName
      if (!shardGroups.has(key)) {
        // First time seeing this shard group
        if (shardInfo.shardNumber === 1) {
          // It's the first shard, keep it
          shardGroups.set(key, true)
          filteredModels.push(model)
        } else {
          // Not the first shard, skip but mark group as seen
          shardGroups.set(key, false)
          skippedShards++
        }
      } else {
        // Already seen this shard group, skip
        skippedShards++
      }
    } else {
      // Not a sharded model, keep it
      filteredModels.push(model)
    }
  }

  if (shardGroups.size > 0) {
    logger.info(`Detected ${shardGroups.size} sharded model group(s) - testing first shard only`)
    if (skippedShards > 0) {
      logger.info(`Skipping ${skippedShards} non-first shard(s)`)
    }
  }

  let modelsToTest = filteredModels
  if (modelIndex !== null) {
    const model = ggufModels.find(m => m.index === modelIndex)
    if (!model) {
      logger.error(`Model at index ${modelIndex} is not a GGUF model`)
      process.exit(1)
    }
    modelsToTest = [model]
  } else {
    // Apply skip if specified
    if (skip > 0) {
      logger.info(`Skipping first ${skip} model(s)`)
      modelsToTest = modelsToTest.slice(skip)
    }

    // Apply start-from if specified
    if (startFrom) {
      const startIndex = modelsToTest.findIndex(m => {
        const filename = m.source.split('/').pop()
        return filename.includes(startFrom)
      })
      if (startIndex === -1) {
        logger.error(`Model matching "${startFrom}" not found`)
        process.exit(1)
      }
      const matchedFilename = modelsToTest[startIndex].source.split('/').pop()
      logger.info(`Starting from model: ${matchedFilename} (position ${startIndex + 1} of ${modelsToTest.length})`)
      modelsToTest = modelsToTest.slice(startIndex)
    }

    // Apply limit if specified
    if (limit !== null) {
      modelsToTest = modelsToTest.slice(0, limit)
    }
  }

  logger.info(`Testing ${modelsToTest.length} model(s)`)

  const tempDir = await fsPromises.mkdtemp(path.join(require('os').tmpdir(), 'gguf-test-'))
  const results = []

  for (const model of modelsToTest) {
    const filename = model.source.split('/').pop()
    const shardInfo = detectShard(model.source)
    logger.info(`\nTesting: ${filename}`)
    if (shardInfo) {
      logger.info(`Shard: ${shardInfo.shardNumber} of ${shardInfo.totalShards} (first shard)`)
    }
    logger.info(`Source: ${model.source}`)

    const localPath = path.join(tempDir, filename)

    try {
      logger.info('Downloading...')

      if (model.source.startsWith('s3://')) {
        // Download from S3
        const s3Url = new URL(model.source)
        const bucket = s3Url.hostname
        const key = s3Url.pathname.substring(1) // Remove leading slash

        const config = new RegistryConfig({ logger })
        const credentials = config.getAWSCredentials()

        const s3Config = {
          region: credentials.region || 'eu-central-1'
        }

        if (credentials.accessKeyId && credentials.secretAccessKey) {
          s3Config.credentials = {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey
          }
        }

        const s3Client = new S3Client(s3Config)
        const { Body } = await s3Client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key
        }))

        const writeStream = createWriteStream(localPath)
        await pipeline(Body, writeStream)
      } else {
        // Download from HuggingFace
        const parsed = parseHfDownloadUrl(model.source)
        if (!parsed) {
          throw new Error('Invalid URL - only HuggingFace and S3 URLs supported')
        }

        const cachePath = await downloadFileToCacheDir({
          repo: parsed.repo,
          path: parsed.hfPath,
          revision: parsed.revision
        })

        await fsPromises.copyFile(cachePath, localPath)
      }

      logger.info('✓ Downloaded successfully')

      logger.info('Extracting metadata...')
      const metadata = await extractGGUFMetadata(localPath)

      if (!metadata) {
        logger.error('✗ Failed to extract metadata')
        results.push({ model: filename, success: false, error: 'Extraction returned null' })
        continue
      }

      logger.info('✓ Extracted metadata successfully')

      // Filter out tokenizer fields (too large and not needed)
      const filteredMetadata = {}
      let tokenizerFieldsSkipped = 0
      for (const [key, value] of Object.entries(metadata)) {
        if (key.startsWith('tokenizer.')) {
          tokenizerFieldsSkipped++
        } else {
          filteredMetadata[key] = value
        }
      }

      const keyCount = Object.keys(filteredMetadata).length
      const architecture = filteredMetadata['general.architecture'] || 'unknown'
      const contextLength = filteredMetadata[`${architecture}.context_length`] || filteredMetadata['llama.context_length'] || 'N/A'
      const fileType = filteredMetadata['general.file_type'] || 'N/A'

      logger.info(`  Architecture: ${architecture}`)
      logger.info(`  Context Length: ${contextLength}`)
      logger.info(`  File Type: ${fileType}`)
      logger.info(`  Total Fields: ${keyCount} (${tokenizerFieldsSkipped} tokenizer fields excluded)`)

      const metadataSize = JSON.stringify(filteredMetadata).length
      logger.info(`  Metadata Size: ${(metadataSize / 1024).toFixed(2)} KB`)

      if (keyCount > 10) {
        logger.info('  Sample fields:')
        const sampleKeys = Object.keys(filteredMetadata).slice(0, 10)
        for (const key of sampleKeys) {
          const value = filteredMetadata[key]
          const displayValue = typeof value === 'string' && value.length > 50
            ? value.substring(0, 50) + '...'
            : value
          logger.info(`    ${key}: ${JSON.stringify(displayValue)}`)
        }
        if (keyCount > 10) {
          logger.info(`    ... (${keyCount - 10} more fields)`)
        }
      }

      results.push({ model: filename, success: true, keyCount, architecture })
    } catch (err) {
      logger.error(`✗ Error: ${err.message}`)
      results.push({ model: filename, success: false, error: err.message })
    } finally {
      // Clean up downloaded file after each test
      try {
        await fsPromises.unlink(localPath)
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
    }
  }

  await fsPromises.rm(tempDir, { recursive: true, force: true })

  logger.info('\n' + '='.repeat(60))
  logger.info('Summary:')
  logger.info('='.repeat(60))

  const successful = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success && !r.skipped).length
  const skipped = results.filter(r => r.skipped).length

  logger.info(`Total tested: ${results.length}`)
  logger.info(`Successful: ${successful}`)
  if (skipped > 0) {
    logger.info(`Skipped: ${skipped}`)
  }
  logger.info(`Failed: ${failed}`)

  if (successful > 0) {
    logger.info('\nSuccessful extractions:')
    for (const result of results.filter(r => r.success)) {
      logger.info(`  ✓ ${result.model} (${result.keyCount} fields, arch: ${result.architecture})`)
    }
  }

  if (failed > 0) {
    logger.info('\nFailed extractions (in test order):')
    const failedResults = results.filter(r => !r.success && !r.skipped)
    for (const result of failedResults) {
      logger.info(`  ✗ ${result.model}: ${result.error}`)
    }

    logger.info('\nTo resume from a specific model, use:')
    logger.info('  npm run test:gguf -- --start-from <model-name>')
    logger.info('Or skip the first N models:')
    logger.info('  npm run test:gguf -- --skip <number>')
  }

  process.exit(failed > 0 ? 1 : 0)
}

function detectShard (sourceUrl) {
  // Pattern: filename-00001-of-00005.gguf, filename-00002-of-00005.gguf, etc.
  const shardPattern = /-(\d{5})-of-(\d{5})\.gguf$/i
  const match = sourceUrl.match(shardPattern)
  if (!match) {
    return null
  }

  const shardNumber = parseInt(match[1], 10)
  const totalShards = parseInt(match[2], 10)
  const baseName = sourceUrl.replace(shardPattern, '')

  return {
    shardNumber,
    totalShards,
    baseName,
    isFirstShard: shardNumber === 1
  }
}

function parseHfDownloadUrl (urlString) {
  const u = new URL(urlString)
  if (u.hostname !== 'huggingface.co') return null

  const parts = u.pathname.split('/').filter(Boolean)
  const isValidPath = (parts[2] === 'resolve' || parts[2] === 'blob') && parts.length >= 5

  if (!isValidPath) {
    return null
  }

  const repo = `${parts[0]}/${parts[1]}`
  const revision = parts[3]
  const hfPath = parts.slice(4).join('/')

  return { repo, revision, hfPath }
}

if (require.main === module) {
  testGGUFExtraction().catch(async (err) => {
    logger.error('Fatal error:', err)
    process.exit(1)
  })
}

module.exports = { testGGUFExtraction }
