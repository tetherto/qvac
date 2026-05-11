'use strict'

const fs = require('fs').promises
const readline = require('readline')
const RegistryConfig = require('../lib/config')

async function cleanup () {
  console.log('⚠️  QVAC Registry Cleanup Tool')
  console.log('This will DELETE all registry data and reset the environment!')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  const answer = await new Promise(resolve => {
    rl.question('Are you sure you want to proceed? (y/n) ', resolve)
  })
  rl.close()
  if (answer.toLowerCase() !== 'y') {
    console.log('Cleanup cancelled.')
    return
  }
  const registryConfig = new RegistryConfig({ logger: console })
  const registryStorage = registryConfig.getRegistryStorage()
  const modelDrivesStorage = registryConfig.getModelDrivesStorage()
  const storages = [registryStorage, modelDrivesStorage].filter(Boolean)
  for (const storage of storages) {
    try {
      await fs.rm(storage, { recursive: true, force: true })
      console.log(`✓ Deleted storage: ${storage}`)
    } catch (err) {
      console.log(`✗ Failed to delete ${storage}: ${err.message}`)
    }
  }
  console.log('\nCleanup complete!')
}

if (require.main === module) cleanup().catch(err => { console.error('Cleanup failed:', err); process.exit(1) })

module.exports = { cleanup }
