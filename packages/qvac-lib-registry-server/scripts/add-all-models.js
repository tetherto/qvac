'use strict'

const path = require('path')
const fs = require('fs').promises

const RegistryConfig = require('../lib/config')
const logger = require('../lib/logger')
const { connectToRegistry } = require('./utils/rpc-client')

async function addAllModels () {
  const args = process.argv.slice(2)
  const limitArg = args.find(arg => arg.startsWith('--limit='))
  let limit = Infinity
  if (limitArg) {
    const parsedLimit = parseInt(limitArg.split('=')[1], 10)
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      throw new Error('Invalid --limit value. Must be a positive integer.')
    }
    limit = parsedLimit
  }

  const fileArg = args.find(arg => arg.startsWith('--file='))
  const filePath = fileArg ? fileArg.split('=')[1] : './data/models.test.json'

  let storage = null
  let primaryKey = null
  const skipExisting = args.includes('--skip-existing')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--storage' || args[i] === '-s') {
      storage = args[++i]
    } else if (args[i] === '--primary-key') {
      primaryKey = args[++i]
    }
  }

  const storesPath = path.resolve(filePath)
  const entries = JSON.parse(await fs.readFile(storesPath, 'utf8'))

  if (!Array.isArray(entries)) {
    throw new Error(`${filePath} must contain an array of entries`)
  }

  const config = new RegistryConfig({ logger })
  if (storage) {
    logger.info('Using writer storage:', storage)
  }
  const connection = await connectToRegistry({ config, logger, storage, primaryKey })

  try {
    let added = 0
    for (const entry of entries) {
      if (added >= limit) break

      if (!entry.source) {
        logger.warn('Skipping entry without source', entry)
        continue
      }

      const payload = {
        source: entry.source,
        engine: entry.engine,
        licenseId: entry.license,
        description: entry.description || '',
        quantization: entry.quantization || '',
        params: entry.params || '',
        notes: entry.notes || '',
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        skipExisting
      }

      logger.info(`Adding model ${entry.source}`)
      if (skipExisting) {
        logger.debug('Skip-existing flag enabled - will skip if model already exists')
      }
      await connection.rpc.request('add-model', payload)
      added++
    }

    logger.info(`Completed: ${added} model(s) added`)
  } finally {
    await connection.cleanup()
  }
}

if (require.main === module) {
  addAllModels().catch(err => {
    logger.error('Fatal error during add-all-models:', err)
    process.exit(1)
  })
}

module.exports = { addAllModels }
