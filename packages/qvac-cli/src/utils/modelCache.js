'use strict'

const { QvacStorage } = require('./storage')
let cacheInstance = null

class ModelCache {
  constructor (cacheFileName = 'model.cache') {
    if (cacheInstance) {
      return cacheInstance
    }
    this.cacheFileName = cacheFileName
    this.storage = QvacStorage.getInstance()
    cacheInstance = this
  }

  static getInstance (cacheFileName) {
    if (!cacheInstance) {
      cacheInstance = new ModelCache(cacheFileName)
    }
    return cacheInstance
  }

  static reset () {
    this.storage?.reset()
    cacheInstance = null
  }

  async addModel (modelString) {
    try {
      // Check if model already exists in cache
      const existingModels = await this.getModelList()
      if (!existingModels.includes(modelString)) {
        // Only append if model isn't already in cache
        await this.storage.appendFile(this.cacheFileName, modelString + '\n')
      }
    } catch (err) {
      throw new Error(`Failed to add model to cache: ${err.message}`)
    }
  }

  async removeModel (modelString) {
    try {
      // Read existing cache
      let cache = ''
      try {
        cache = await this.storage.readFile(this.cacheFileName)
      } catch (err) {
        if (err.code === 'ENOENT') return // File doesn't exist, nothing to remove
        throw err
      }

      // Filter out the model string
      const updatedCache = cache
        .split('\n')
        .filter(line => line !== modelString)
        .join('\n')

      // Write back filtered cache
      await this.storage.addFile(this.cacheFileName, updatedCache)
    } catch (err) {
      throw new Error(`Failed to remove model from cache: ${err.message}`)
    }
  }

  async getModelList () {
    try {
      const content = await this.storage.readFile(this.cacheFileName)
      if (!content.trim()) {
        return []
      }
      return content.split('\n').filter(line => line.trim())
    } catch (err) {
      if (err.code === 'ENOENT') {
        return []
      }
      throw err
    }
  }
}

module.exports = { ModelCache }
