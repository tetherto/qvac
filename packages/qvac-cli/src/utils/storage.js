'use strict'

const fs = require('fs')
const fsAsync = require('fs/promises')
const path = require('path')
const { parseEnvVars } = require('./config')

let storageInstance = null

class QvacStorage {
  constructor (config) {
    if (storageInstance) {
      return storageInstance
    }
    this.storageRoot = config.storageDir
    storageInstance = this
  }

  static getInstance () {
    if (!storageInstance) {
      storageInstance = new QvacStorage(parseEnvVars())
      storageInstance._ready()
    }
    return storageInstance
  }

  static reset () {
    storageInstance = null
  }

  // Create a file with relative path
  async addFile (name, content) {
    // Handle both flat files and nested paths
    const filePath = path.join(this.storageRoot, name)
    const dir = path.dirname(filePath)
    await fsAsync.mkdir(dir, { recursive: true })
    await fsAsync.writeFile(filePath, content)
  }

  async appendFile (name, content) {
    const filePath = path.join(this.storageRoot, name)
    try {
      return await fsAsync.appendFile(filePath, content)
    } catch (err) {
      if (err.code === 'ENOENT') {
        await this.addFile(name, content)
      } else {
        throw err
      }
    }
  }

  async readFile (name) {
    const filePath = path.join(this.storageRoot, name)
    return fsAsync.readFile(filePath, 'utf8')
  }

  _ready () {
    fs.mkdir(this.storageRoot, { recursive: true }, (err) => {
      if (err) {
        throw err
      }
    })
  }
}

module.exports = {
  QvacStorage
}
