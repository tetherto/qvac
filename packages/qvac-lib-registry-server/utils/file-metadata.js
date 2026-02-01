'use strict'

const fsPromises = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const { createReadStream } = require('fs')

async function calculateFileChecksum (filePath) {
  const hash = crypto.createHash('sha256')
  const stream = createReadStream(filePath)

  for await (const chunk of stream) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

async function getFileMetadata (filePath) {
  const stats = await fsPromises.stat(filePath)
  const checksum = await calculateFileChecksum(filePath)

  return {
    filename: path.basename(filePath),
    checksum,
    bytesize: stats.size
  }
}

module.exports = {
  calculateFileChecksum,
  getFileMetadata
}
