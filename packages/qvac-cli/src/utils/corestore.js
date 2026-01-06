'use strict'

const Corestore = require('corestore')

let storeInstance = null

/**
 * Initializes and returns a singleton Corestore instance.
 * @returns {Promise<Corestore>} - The Corestore instance.
 */
async function getCorestoreInstance (config) {
  if (storeInstance && storeInstance.closed) {
    storeInstance = null
  }

  if (storeInstance) {
    await storeInstance.ready()
    return storeInstance
  }

  storeInstance = new Corestore(config.qvacCoreStoreDir)
  await storeInstance.ready()
  return storeInstance
}

module.exports = {
  getCorestoreInstance
}
