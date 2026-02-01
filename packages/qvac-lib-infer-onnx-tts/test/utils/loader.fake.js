'use strict'

const Base = require('@qvac/dl-base')
const path = require('bare-path')
const { Readable } = require('bare-stream')

// Fake files available via the loader.
const files = {
  'ggml-tiny.bin': Buffer.from('binary file ggml-tiny.bin')
}

class FakeDL extends Base {
  async start () { }

  async stop () { }

  async list (path) {
    return Object.keys(files)
  }

  async getStream (filepath) {
    const name = path.basename(filepath)
    return Readable.from(Buffer.from(files[name]))
  }

  async download (filepath, destPath) {
    const name = path.basename(filepath)
    const content = files[name]
    if (!content) {
      throw new Error(`File ${filepath} not found`)
    }

    // Simulate downloading by returning a response object with await method
    return {
      await: async () => ({
        success: true,
        filepath,
        destPath,
        size: content.length
      })
    }
  }
}

module.exports = FakeDL
