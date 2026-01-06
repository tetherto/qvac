'use strict'

const os = require('os')
const path = require('path')
const process = require('process')

let configInstance = null

function parseEnvVars () {
  if (configInstance) {
    return configInstance
  }

  const storageDir = process.env.QVAC_STORAGE_DIR || path.join(os.homedir(), '.qvac/storage')

  configInstance = {
    logLevel: process.env.QVAC_LOGLVL || 'info',
    cacheDir: process.env.QVAC_CACHE_DIR,
    // Temp, rm after we go public
    ghToken: process.env.GH_TOKEN, // Github Personal Access Token
    storageDir,
    qvacCoreStoreDir: process.env.QVAC_CORESTORE_DIR || path.join(storageDir, 'corestore'),
    qvacHyperbeeKey: process.env.QVAC_HYPERBEE_KEY || '8919220166add186b84c882b5f4a2c56357e02f459a20b423a3ea7826ec70781'
  }

  return configInstance
}

module.exports = { parseEnvVars }
