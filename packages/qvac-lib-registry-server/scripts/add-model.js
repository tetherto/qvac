'use strict'

const path = require('path')
const fsPromises = require('fs').promises

const RegistryConfig = require('../lib/config')
const logger = require('../lib/logger')
const { connectToRegistry } = require('./utils/rpc-client')

async function addModel () {
  // Parse command line arguments
  const args = process.argv.slice(2)
  let canonicalSource = null
  let storage
  let primaryKey
  let modelsFile = './data/models.test.json'

  // Parse arguments
  const skipExisting = args.includes('--skip-existing')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--storage' || args[i] === '-s') {
      storage = args[++i]
    } else if (args[i] === '--primary-key') {
      primaryKey = args[++i]
    } else if (args[i] === '--models-file' || args[i] === '-f') {
      modelsFile = args[++i]
    } else if (!canonicalSource && args[i] !== '--skip-existing') {
      canonicalSource = args[i]
    }
  }

  if (!canonicalSource) {
    logger.error('Usage: npm run add-model -- <canonical-source-url> [options]')
    logger.error('')
    logger.error('Options:')
    logger.error('  --models-file, -f <path>  Models JSON file (default: ./data/models.test.json)')
    logger.error('  --storage, -s <path>      Writer storage path')
    logger.error('  --primary-key <key>       Primary key (hex)')
    logger.error('  --skip-existing           Skip if model already exists')
    logger.error('')
    logger.error('Examples:')
    logger.error('  npm run add-model -- https://huggingface.co/.../model.bin')
    logger.error('  npm run add-model -- https://huggingface.co/.../model.bin -f ./data/models.prod.json')
    process.exit(1)
  }

  logger.info('Adding model from source:', canonicalSource)
  logger.info('Using models file:', modelsFile)
  if (storage) {
    logger.info('Using writer storage:', storage)
  }

  // Load model stores data
  const storesPath = path.resolve(modelsFile)
  const storesData = JSON.parse(await fsPromises.readFile(storesPath, 'utf8'))
  if (!Array.isArray(storesData)) {
    logger.error(`${modelsFile} must contain an array of model definitions`)
    process.exit(1)
  }

  const modelEntry = storesData.find(entry => entry.source === canonicalSource)
  if (!modelEntry) {
    logger.error(`Model not found in ${modelsFile} for source ${canonicalSource}`)
    logger.error('First 10 available sources:')
    storesData.slice(0, 10).forEach(entry => logger.error(`  - ${entry.source}`))
    process.exit(1)
  }

  // Get registry config
  const config = new RegistryConfig({ logger })
  const registryCoreKey = config.getRegistryCoreKey()

  if (!registryCoreKey) {
    logger.error('QVAC_REGISTRY_CORE_KEY not set. Run "node scripts/bin.js run" once to initialize keys.')
    process.exit(1)
  }

  logger.info('Connecting to registry service...')
  logger.info('Registry core key:', registryCoreKey)

  const connection = await connectToRegistry({ config, logger, storage, primaryKey })

  const modelRequest = {
    source: modelEntry.source,
    engine: modelEntry.engine,
    licenseId: modelEntry.licenseId,
    description: modelEntry.description || '',
    quantization: modelEntry.quantization || '',
    params: modelEntry.params || '',
    notes: modelEntry.notes || '',
    tags: Array.isArray(modelEntry.tags) ? modelEntry.tags : [],
    skipExisting
  }

  try {
    logger.info('Sending add-model request...')
    if (skipExisting) {
      logger.info('Skip-existing flag enabled - will skip if model already exists')
    }
    const response = await connection.rpc.request('add-model', modelRequest)

    logger.info('✅ Model added successfully!')
    logger.info('Model path:', response.model.path)
    logger.info('Model source:', response.model.source)
  } catch (err) {
    logger.error('Failed to add model:', err)
    throw err
  } finally {
    await connection.cleanup()
  }
}

if (require.main === module) {
  addModel().catch(async (err) => {
    logger.error('Fatal error:', err)
    process.exit(1)
  })
}

module.exports = { addModel }
