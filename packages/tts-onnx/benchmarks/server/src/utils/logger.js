'use strict'

const getTimestamp = () => {
  return new Date().toISOString()
}

const logger = {
  info: (...args) => {
    console.log(`[${getTimestamp()}] [INFO]`, ...args)
  },
  error: (...args) => {
    console.error(`[${getTimestamp()}] [ERROR]`, ...args)
  },
  warn: (...args) => {
    console.warn(`[${getTimestamp()}] [WARN]`, ...args)
  },
  debug: (...args) => {
    console.log(`[${getTimestamp()}] [DEBUG]`, ...args)
  }
}

module.exports = logger
