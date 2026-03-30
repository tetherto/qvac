'use strict'

const Base = require('@qvac/dl-base')
const path = require('bare-path')
const { Readable } = require('bare-stream')

// Fake files available via the loader (simulating Parakeet model files)
const files = {
  'conf.json': '{ "modelType": "tdt" }',
  'encoder-model.onnx': Buffer.from('mock encoder model data'),
  'encoder-model.onnx.data': Buffer.from('mock encoder model weights'),
  'decoder_joint-model.onnx': Buffer.from('mock decoder model data'),
  'vocab.txt': Buffer.from('▁the 0\n▁a 1\n▁is 2\n</s> 3\n<pad> 4'),
  'preprocessor.onnx': Buffer.from('mock preprocessor model data')
}

class FakeDL extends Base {
  async start () { }

  async stop () { }

  async list (dirPath) {
    return Object.keys(files)
  }

  async getStream (filepath) {
    const name = path.basename(filepath)
    return Readable.from(Buffer.from(files[name] || ''))
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
