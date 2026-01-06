'use strict'

/**
 * Simple logger wrapper around console with consistent formatting
 */
class Logger {
  constructor () {
    this._level = this._getLevelFromEnv()
  }

  _getLevelFromEnv () {
    const level = process.env.LOG_LEVEL || 'info'
    const levels = ['debug', 'info', 'warn', 'error']
    return levels.includes(level.toLowerCase()) ? level.toLowerCase() : 'info'
  }

  _shouldLog (level) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 }
    return levels[level] >= levels[this._level]
  }

  _getTimestamp () {
    return new Date().toISOString()
  }

  debug (...args) {
    if (this._shouldLog('debug')) {
      console.log(`[${this._getTimestamp()}] [DEBUG]`, ...args)
    }
  }

  info (...args) {
    if (this._shouldLog('info')) {
      console.log(`[${this._getTimestamp()}] [INFO]`, ...args)
    }
  }

  warn (...args) {
    if (this._shouldLog('warn')) {
      console.warn(`[${this._getTimestamp()}] [WARN]`, ...args)
    }
  }

  error (...args) {
    if (this._shouldLog('error')) {
      console.error(`[${this._getTimestamp()}] [ERROR]`, ...args)
    }
  }
}

module.exports = new Logger()
