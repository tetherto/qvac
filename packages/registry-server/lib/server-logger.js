'use strict'

const pino = require('pino')

module.exports = function createLogger() {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  })
}
