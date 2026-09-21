// Named log levels.
export const LOG_LEVELS = Object.freeze({
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  OFF: 'off'
} as const)

export type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS]

// Numeric priorities for each log level (lower is higher priority).
export const LEVEL_PRIORITIES: Readonly<Record<LogLevel, number>> = Object.freeze({
  [LOG_LEVELS.ERROR]: 0,
  [LOG_LEVELS.WARN]: 1,
  [LOG_LEVELS.INFO]: 2,
  [LOG_LEVELS.DEBUG]: 3,
  [LOG_LEVELS.OFF]: 4
})

// Default logging level when none is specified.
export const DEFAULT_LEVEL: LogLevel = LOG_LEVELS.INFO

export const ENV_LOG_LEVEL = 'QVAC_LOG_LEVEL'
