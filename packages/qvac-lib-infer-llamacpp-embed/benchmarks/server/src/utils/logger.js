'use strict'

const process = require('bare-process')

const levels = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR'
}

const formatPart = (value) => {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const log = (level, ...parts) => {
  const timestamp = new Date().toISOString()
  const message = parts.map(formatPart).join(' ')
  const logMessage = `[${timestamp}] [${level}] ${message}\n`
  process.stdout.write(logMessage)
}

module.exports = {
  debug: (...args) => log(levels.debug, ...args),
  info: (...args) => log(levels.info, ...args),
  warn: (...args) => log(levels.warn, ...args),
  error: (...args) => log(levels.error, ...args)
}
