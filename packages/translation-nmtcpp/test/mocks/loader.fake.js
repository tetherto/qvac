'use strict'

/**
 * Fake Download Loader (Mock)
 *
 * Simulates a file download loader for testing without network/disk access.
 * Returns predefined fake files: conf.json, 1.bin, 2.bin
 *
 * Used by: test/unit/*.test.js
 */

const path = require('bare-path')
const { Readable } = require('bare-stream')

const files = {
  'conf.json': '{ "doit": "all" }',
  '1.bin': Buffer.from('first binary file'),
  '2.bin': Buffer.from('second binary file')
}

// Standalone fake loader implementing the data-loader surface used by tests
// (start/stop/list/getStream). It deliberately does not extend any base class
// so the test suite carries no dependency on the deprecated @qvac/dl-* packages.
class FakeDL {
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
