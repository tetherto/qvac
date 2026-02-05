'use strict'

const { getEnv } = require('../utils/env')
const { ENV_KEYS } = require('@tetherto/qvac-registry-schema-mono')
const Logger = require('./logger')
const os = require('os')
const path = require('path')

class RegistryConfig {
  constructor (opts = {}) {
    this.logger = new Logger(opts.logger)
    this.logger.debug('RegistryConfig initialized', { opts })
  }

  getRegistryStorage (providedPath) {
    if (providedPath) {
      this.logger.debug('getRegistryStorage called with providedPath', { providedPath })
      return providedPath
    }

    const envPath = getEnv(ENV_KEYS.REGISTRY_STORAGE)
    const result = envPath || this._createTempStoragePath()
    this.logger.debug('getRegistryStorage resolved', { envPath, result })
    return result
  }

  _createTempStoragePath () {
    const tmpBase = os.tmpdir()
    const storageDir = path.join(tmpBase, `qvac-registry-client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
    this.logger.debug('Created temp storage path', { storageDir })
    return storageDir
  }

  getRegistryCoreKey (providedKey) {
    if (providedKey) {
      this.logger.debug('getRegistryCoreKey called with providedKey', { providedKey })
      return providedKey
    }

    const envKey = getEnv(ENV_KEYS.QVAC_REGISTRY_CORE_KEY)
    this.logger.debug('getRegistryCoreKey loaded from env', { envKey })
    return envKey || null
  }
}

module.exports = RegistryConfig
