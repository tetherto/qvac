'use strict'

const levels = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR'
}

const log = (level, message) => {
  const timestamp = new Date().toISOString()
  const logMessage = `[${timestamp}] [${level}] ${message}\n`
  process.stdout.write(logMessage)
}

module.exports = {
  debug: (msg) => log(levels.debug, msg),
  info: (msg) => log(levels.info, msg),
  warn: (msg) => log(levels.warn, msg),
  error: (msg) => log(levels.error, msg)
}
