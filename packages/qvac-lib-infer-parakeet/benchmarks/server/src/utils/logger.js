'use strict'

const process = require('bare-process')

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
}

const envLogLevel = process.env?.LOG_LEVEL?.toUpperCase()
const currentLevel = LOG_LEVELS[envLogLevel] ?? LOG_LEVELS.INFO

const formatMessage = (level, message, data) => {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` ${JSON.stringify(data)}` : ''
  return `[${timestamp}] [${level}] ${message}${dataStr}`
}

const logger = {
  error: (message, data) => {
    if (currentLevel >= LOG_LEVELS.ERROR) {
      console.error(formatMessage('ERROR', message, data))
    }
  },
  warn: (message, data) => {
    if (currentLevel >= LOG_LEVELS.WARN) {
      console.warn(formatMessage('WARN', message, data))
    }
  },
  info: (message, data) => {
    if (currentLevel >= LOG_LEVELS.INFO) {
      console.log(formatMessage('INFO', message, data))
    }
  },
  debug: (message, data) => {
    if (currentLevel >= LOG_LEVELS.DEBUG) {
      console.log(formatMessage('DEBUG', message, data))
    }
  }
}

module.exports = logger
