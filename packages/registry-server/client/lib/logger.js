'use strict'

class Logger {
  constructor (opts = {}) {
    this.level = opts.level || 'info'
    this.name = opts.name || 'QVACRegistryClient'
    this.enabled = opts.enabled !== false

    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    }
  }

  _shouldLog (level) {
    if (!this.enabled) return false
    return this.levels[level] >= this.levels[this.level]
  }

  _log (level, ...args) {
    if (!this._shouldLog(level)) return
    const prefix = `[${this.name}] [${level.toUpperCase()}]`
    console[level](prefix, ...args)
  }

  debug (...args) {
    this._log('debug', ...args)
  }

  info (...args) {
    this._log('info', ...args)
  }

  warn (...args) {
    this._log('warn', ...args)
  }

  error (...args) {
    this._log('error', ...args)
  }
}

module.exports = Logger
