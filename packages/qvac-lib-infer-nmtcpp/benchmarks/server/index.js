'use strict'
const process = require('bare-process')
const { server } = require('./src/server')
const logger = require('./src/utils/logger')

const port = 8080

server.listen(port, () => {
  logger.info(`Server is running on port ${port}`)
})
server.on('error', (error) => {
  logger.error('Server error:', error)
})

/**
 * Shutdown the server
 */
const shutdown = () => {
  logger.info('Shutting down server...')
  server.close(err => {
    if (err) {
      logger.error('Error during shutdown', err)
      process.exit(1)
    }
    logger.info('Server gracefully stopped')
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
