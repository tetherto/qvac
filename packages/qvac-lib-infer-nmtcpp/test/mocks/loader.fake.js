'use strict'

const Base = require('@qvac/dl-base')
const path = require('bare-path')
const { Readable } = require('bare-stream')

const files = {
  'conf.json': '{ "doit": "all" }',
  '1.bin': Buffer.from('first binary file'),
  '2.bin': Buffer.from('second binary file')
}

class FakeDL extends Base {
  async start () {
  }

  async stop () {
  }

  async list (path) {
    return [...Object.keys(files)]
  }

  async getStream (filepath) {
    const name = path.basename(filepath)
    return Readable.from(Buffer.from(files[name]))
  }
}

module.exports = FakeDL
