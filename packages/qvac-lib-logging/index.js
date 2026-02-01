'use strict'

const {
  LOG_LEVELS, LEVEL_PRIORITIES, DEFAULT_LEVEL, ENV_LOG_LEVEL
} = require('./constants')

let qvacLoggerProcess
if (typeof global !== 'undefined' && global.process) {
  qvacLoggerProcess = global.process
} else {
  try {
    qvacLoggerProcess = require('process')
  } catch (e) {
    try {
      qvacLoggerProcess = require('bare-process')
    } catch (e2) {
      qvacLoggerProcess = { env: {} }
    }
  }
}

/**
 * Ensures the provided logger implements the required interface.
 * @param {Object} logger - Logger object to validate.
 * @throws {Error} If any required logging method is missing.
 */
function assertLoggerInterface (logger) {
  Object.values(LOG_LEVELS)
    .filter(level => level !== LOG_LEVELS.OFF)
    .forEach(method => {
      if (typeof logger[method] !== 'function') {
        throw new Error(`Logger must implement method: ${method}`)
      }
    })
}

/**
 * Attempt to detect an existing log‐level setting on a wrapped logger.
 *
 * @param {object} logger
 *   The wrapped logger to inspect. May implement:
 *   - `logger.getLevel(): string` returning one of LOG_LEVELS,
 *   - `logger.level(): string` returning one of LOG_LEVELS (case-insensitive),
 *   - or a `logger.level` string property.
 *
 * @returns {string|null}
 *   The detected log level (one of LOG_LEVELS) if found, otherwise `null`.
 */
function getLevelFromLogger (logger) {
  if (typeof logger.getLevel === 'function') {
    const lvl = logger.getLevel()
    if (typeof lvl === 'string' &&
            Object.values(LOG_LEVELS).includes(lvl.toLowerCase())
    ) {
      return lvl
    }
  }

  if (typeof logger.level === 'function') {
    const lvl = logger.level()
    if (typeof lvl === 'string' &&
            Object.values(LOG_LEVELS).includes(lvl.toLowerCase())
    ) {
      return lvl
    }
  }

  if (
    typeof logger.level === 'string' &&
        Object.values(LOG_LEVELS).includes(logger.level.toLowerCase())
  ) {
    return logger.level
  }

  return null
}

/**
 * Check the environment variable for a log level setting.
 * @returns {null|string} Valid log level or null if not set or invalid.
 */
function getLogLevelFromEnv () {
  const env = (qvacLoggerProcess && qvacLoggerProcess.env) || {}
  const envLevel = env[ENV_LOG_LEVEL] || env[`EXPO_PUBLIC_${ENV_LOG_LEVEL}`]
  if (envLevel && Object.values(LOG_LEVELS).includes(envLevel.toLowerCase())) {
    return envLevel.toLowerCase()
  }
  return null
}

/**
 * A wrapper around any logger implementing .error/.warn/.info/.debug,
 * with runtime-configurable log levels and an OFF state.
 */
class QvacLogger {
  /**
     * Expose the available log level constants.
     * @type {Object.<string,string>}
     * @static
     * @memberof QvacLogger
     */
  static LOG_LEVELS = LOG_LEVELS

  /**
     * Create a new QvacLogger.
     *
     * If no `logger` is provided, defaults to `console` and starts at OFF.
     * Otherwise, it will inherit the wrapped logger’s own level (via .getLevel()
     * or .level), falling back to DEFAULT_LEVEL if none is found.
     *
     * @param {Object} [logger] - Underlying logger with the required methods.
     */
  constructor (logger) {
    this._logger = logger

    if (!this._logger) {
      this._level = LOG_LEVELS.OFF
      return
    }

    assertLoggerInterface(this._logger)

    // Environment variable takes precedence over the logger's level.
    this._level = getLogLevelFromEnv() ?? getLevelFromLogger(this._logger) ?? DEFAULT_LEVEL
  }

  /**
     * Update the current log level.
     *
     * @param {string} newLevel - One of the LOG_LEVELS constants.
     * @throws {Error} If `newLevel` is not a valid level.
     */
  setLevel (newLevel) {
    if (!Object.values(LOG_LEVELS).includes(newLevel)) {
      throw new Error(`Invalid log level: ${newLevel}`)
    }
    this._level = newLevel
  }

  /**
     * Get the current log level.
     *
     * @returns {string} The active log level.
     */
  getLevel () {
    return this._level
  }

  /**
     * Internal helper to route messages to the underlying logger
     * if the message’s level is at-or-above the current threshold.
     *
     * @private
     * @param {string} level - Level of this message.
     * @param {...*} messages - Data or strings to log.
     */
  _log (level, ...messages) {
    if (!this._logger || this._level === LOG_LEVELS.OFF || LEVEL_PRIORITIES[level] > LEVEL_PRIORITIES[this._level]) {
      return
    }
    this._logger[level](...messages)
  }

  error (...msgs) {
    this._log(LOG_LEVELS.ERROR, ...msgs)
  }

  warn (...msgs) {
    this._log(LOG_LEVELS.WARN, ...msgs)
  }

  info (...msgs) {
    this._log(LOG_LEVELS.INFO, ...msgs)
  }

  debug (...msgs) {
    this._log(LOG_LEVELS.DEBUG, ...msgs)
  }
}

module.exports = QvacLogger
