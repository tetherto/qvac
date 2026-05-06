'use strict'

const { setLogger, releaseLogger } = require('../../addonLogging')

const PRIORITY_NAMES = {
  0: 'ERROR',
  1: 'WARNING',
  2: 'INFO',
  3: 'DEBUG',
  4: 'OFF'
}

/**
 * Attaches the spec-mandated logger so native logs match the required format.
 * @param {Object} [options]
 * @param {boolean} [options.forwardToConsole=true] mirror logs to stdout
 * @param {Function} [options.onLog] optional callback receiving formatted log
 * @returns {{logs: string[], release: Function}}
 */
function attachSpecLogger (options = {}) {
  const { forwardToConsole = true, onLog } = options
  const logs = []

  setLogger((priority, message) => {
    const priorityName = PRIORITY_NAMES[priority] || 'UNKNOWN'
    const timestamp = new Date().toISOString()
    const formatted = `[${timestamp}] [C++ TEST] [${priorityName}]: ${message}`
    logs.push(formatted)

    if (forwardToConsole) {
      console.log(formatted)
    }

    if (typeof onLog === 'function') {
      onLog(formatted, priority, message)
    }
  })

  return {
    logs,
    release: () => {
      releaseLogger()
    }
  }
}

module.exports = {
  attachSpecLogger
}
