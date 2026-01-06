'use strict'

const RegistryConfig = require('../lib/config')
const logger = require('../lib/logger')
const { connectToRegistry } = require('./utils/rpc-client')

async function deleteModel () {
  const args = process.argv.slice(2)
  let modelPath = null
  let source = null
  let storage = null
  let primaryKey = null

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' || args[i] === '-p') {
      modelPath = args[++i]
    } else if (args[i] === '--source' || args[i] === '-s') {
      source = args[++i]
    } else if (args[i] === '--storage') {
      storage = args[++i]
    } else if (args[i] === '--primary-key') {
      primaryKey = args[++i]
    }
  }

  if (!modelPath || !source) {
    logger.error('Usage: node scripts/delete-model.js --path <model-path> --source <hf|s3> [--storage <path>] [--primary-key <key>]')
    logger.error('')
    logger.error('Example: node scripts/delete-model.js --path "BSC-LT/salamandraTA-2B-instruct-GGUF/blob/.../model.gguf" --source hf')
    logger.error('Example: node scripts/delete-model.js --path "bucket/key/model.bin" --source s3')
    process.exit(1)
  }

  // Validate source protocol
  if (source !== 'hf' && source !== 's3') {
    logger.error('Source must be either "hf" (HuggingFace) or "s3"')
    process.exit(1)
  }

  logger.info('Deleting model', { path: modelPath, source })

  const config = new RegistryConfig({ logger })
  const connection = await connectToRegistry({ config, logger, storage, primaryKey })

  try {
    logger.info('Sending delete-model request...')
    const result = await connection.rpc.request('delete-model', {
      path: modelPath,
      source
    })

    logger.info('✅ Model deleted successfully!')
    logger.info('Model path:', result.path)
    logger.info('Model source:', result.source)
  } catch (err) {
    logger.error('Failed to delete model:', err)
    throw err
  } finally {
    await connection.cleanup()
  }
}

if (require.main === module) {
  deleteModel().catch(async (err) => {
    logger.error('Fatal error:', err)
    process.exit(1)
  })
}

module.exports = { deleteModel }
