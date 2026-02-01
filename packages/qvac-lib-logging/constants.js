'use strict'

/**
 * Named log levels.
 * @readonly
 * @enum {string}
 */
const LOG_LEVELS = Object.freeze({
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  OFF: 'off'
})

/**
 * Numeric priorities for each log level (lower is higher priority).
 * @readonly
 * @type {Object.<string, number>}
 */
const LEVEL_PRIORITIES = Object.freeze({
  [LOG_LEVELS.ERROR]: 0,
  [LOG_LEVELS.WARN]: 1,
  [LOG_LEVELS.INFO]: 2,
  [LOG_LEVELS.DEBUG]: 3,
  [LOG_LEVELS.OFF]: 4
})

/**
 * Default logging level when none is specified.
 * @type {string}
 */
const DEFAULT_LEVEL = LOG_LEVELS.INFO

const ENV_LOG_LEVEL = 'QVAC_LOG_LEVEL'

module.exports = {
  LOG_LEVELS,
  DEFAULT_LEVEL,
  LEVEL_PRIORITIES,
  ENV_LOG_LEVEL
}
