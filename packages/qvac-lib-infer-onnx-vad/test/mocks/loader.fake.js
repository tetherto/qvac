'use strict'

const Base = require('@tetherto/qvac-lib-dl-base')
const { Readable } = require('bare-stream')

// Fake files available via the loader.
const files = {
  'conf.json': '{ "doit": "all" }',
  '0.bin': Buffer.from('binary file 0'),
  '1.bin': Buffer.from('binary file 1'),
  '2.bin': Buffer.from('binary file 2'),
  '3.bin': Buffer.from('binary file 3')
}

class FakeDL extends Base {
  async start () {}

  async stop () {}

  async list (path) {
    return Object.keys(files)
  }

  async getStream (filepath) {
    return Readable.from(Buffer.from('binary file 0'))
  }
}

module.exports = FakeDL
