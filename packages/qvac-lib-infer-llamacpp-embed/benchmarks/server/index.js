'use strict'

const process = require('bare-process')

global.process = require('bare-process')

const { server } = require('./src/server')
const logger = require('./src/utils/logger')
const { modelManager } = require('./src/services/modelManager')
const fs = require('bare-fs')
const path = require('bare-path')

// Parse PORT as integer, default to 7357
const port = parseInt(process.env.PORT, 10) || 7357

// Clean up stale database lock files on startup
const cleanupDatabaseLocks = () => {
  try {
    const storeDir = path.join(__dirname, 'store')

    // Function to recursively find and remove LOCK files
    const removeLockFiles = (dir) => {
      if (!fs.existsSync(dir)) return

      const items = fs.readdirSync(dir)
      for (const item of items) {
        const itemPath = path.join(dir, item)
        const stat = fs.statSync(itemPath)

        if (stat.isDirectory()) {
          removeLockFiles(itemPath)
        } else if (item === 'LOCK') {
          logger.info(`Removing stale lock file: ${itemPath}`)
          fs.unlinkSync(itemPath)
        }
      }
    }

    removeLockFiles(storeDir)
    logger.info('Database lock cleanup completed')
  } catch (error) {
    logger.warn('Could not clean database lock files:', error.message)
  }
}

// Clean up locks before starting
cleanupDatabaseLocks()

server.listen(port, () => {
  logger.info(`EmbedLlamacpp Benchmark Server is running on port ${port}`)
})

server.on('error', (error) => {
  logger.error('Server error:', {
    message: error.message,
    stack: error.stack,
    name: error.name,
    code: error.code,
    toString: String(error),
    fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
  })

  // Try to clean up and restart on database errors
  if (error.message && error.message.includes('LOCK')) {
    logger.info('Database lock error detected, attempting cleanup...')
    cleanupDatabaseLocks()
  }
})

/**
 * Shutdown the server gracefully
 * Ensures async cleanup operations complete before process exit
 */
const shutdown = async () => {
  logger.info('Shutting down server...')

  // Unload model from VRAM
  try {
    await modelManager.unloadModel()
  } catch (error) {
    logger.warn('Error unloading model during shutdown:', error)
  }

  // Clean up database locks on shutdown
  cleanupDatabaseLocks()

  // Close server and exit
  return new Promise((resolve) => {
    server.close(err => {
      if (err) {
        logger.error('Error during shutdown', err)
        resolve(1)
      } else {
        logger.info('Server gracefully stopped')
        resolve(0)
      }
    })
  })
}

/**
 * Signal handler wrapper that properly awaits async shutdown
 * @param {string} signal - Signal name for logging
 */
const handleSignal = (signal) => {
  logger.info(`Received ${signal}, initiating graceful shutdown...`)
  shutdown()
    .then((exitCode) => {
      process.exit(exitCode)
    })
    .catch((error) => {
      logger.error('Unexpected error during shutdown:', error)
      process.exit(1)
    })
}

process.on('SIGINT', () => handleSignal('SIGINT'))
process.on('SIGTERM', () => handleSignal('SIGTERM'))
