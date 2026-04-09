'use strict'

const { gguf } = require('@huggingface/gguf')
const logger = require('./logger')

function isGGUFSource (sourceUrl) {
  if (typeof sourceUrl !== 'string') {
    return false
  }
  return sourceUrl.toLowerCase().endsWith('.gguf')
}

function isFirstShard (sourceUrl) {
  if (!isGGUFSource(sourceUrl)) {
    return false
  }

  // Pattern: filename-00001-of-00005.gguf, filename-00002-of-00005.gguf, etc.
  const shardPattern = /-(\d{5})-of-(\d{5})\.gguf$/i
  const match = sourceUrl.match(shardPattern)
  if (!match) {
    // Not a sharded model, treat as "first shard" (single file)
    return true
  }

  const shardNumber = parseInt(match[1], 10)
  return shardNumber === 1
}

function serializeBigInts (obj) {
  if (obj === null || obj === undefined) {
    return obj
  }

  if (typeof obj === 'bigint') {
    return obj.toString()
  }

  if (Array.isArray(obj)) {
    return obj.map(serializeBigInts)
  }

  if (typeof obj === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeBigInts(value)
    }
    return result
  }

  return obj
}

async function extractGGUFMetadata (filePath) {
  try {
    const { metadata } = await gguf(filePath, { allowLocalFile: true })

    if (!metadata || typeof metadata !== 'object') {
      logger.warn('GGUF metadata extraction returned invalid result', { filePath })
      return null
    }

    const serializedMetadata = serializeBigInts(metadata)

    // Filter out tokenizer fields (too large and not needed for registry metadata)
    const filteredMetadata = {}
    let tokenizerFieldsSkipped = 0
    for (const [key, value] of Object.entries(serializedMetadata)) {
      if (key.startsWith('tokenizer.')) {
        tokenizerFieldsSkipped++
      } else {
        filteredMetadata[key] = value
      }
    }

    const keyCount = Object.keys(filteredMetadata).length
    const architecture = filteredMetadata['general.architecture'] || 'unknown'

    logger.info('GGUF metadata extracted', {
      filePath,
      architecture,
      keyCount,
      tokenizerFieldsSkipped
    })

    return filteredMetadata
  } catch (err) {
    // Detect GGUF version to provide better error context
    let ggufVersion = 'unknown'
    try {
      const fs = require('fs')
      const fd = fs.openSync(filePath, 'r')
      const buffer = Buffer.allocUnsafe(8)
      fs.readSync(fd, buffer, 0, 8, 0)
      fs.closeSync(fd)
      ggufVersion = buffer.readUInt32LE(4)
    } catch (e) {
      // Ignore version detection errors
    }

    const isArrayBufferError = err.message && err.message.includes('ArrayBuffer')
    const isV3Issue = isArrayBufferError && (ggufVersion === 3 || ggufVersion === '3')

    logger.warn('Failed to extract GGUF metadata', {
      filePath,
      error: err.message,
      ggufVersion,
      note: isV3Issue
        ? 'GGUF v3 files have incomplete support in @huggingface/gguf library (known issue)'
        : isArrayBufferError
          ? 'ArrayBuffer error - may be a library compatibility issue'
          : undefined
    })
    return null
  }
}

module.exports = {
  isGGUFSource,
  isFirstShard,
  extractGGUFMetadata
}
