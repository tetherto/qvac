'use strict'

const process = require('bare-process')

const levels = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR'
}

const log = (level, ...args) => {
  const timestamp = new Date().toISOString()
  const message = args.map(arg => {
    if (arg instanceof Error) {
      return arg.stack || arg.message
    }
    if (typeof arg === 'object') {
      return JSON.stringify(arg)
    }
    return String(arg)
  }).join(' ')
  const logMessage = `[${timestamp}] [${level}] ${message}\n`
  process.stdout.write(logMessage)
}

module.exports = {
  debug: (...args) => log(levels.debug, ...args),
  info: (...args) => log(levels.info, ...args),
  warn: (...args) => log(levels.warn, ...args),
  error: (...args) => log(levels.error, ...args)
}
