import {
  LOG_LEVELS,
  LEVEL_PRIORITIES,
  DEFAULT_LEVEL,
  ENV_LOG_LEVEL,
  type LogLevel
} from './constants.js'
import env from '#env'

export type { LogLevel } from './constants.js'

export interface LoggerInterface {
  error: (...args: any[]) => void
  warn: (...args: any[]) => void
  info: (...args: any[]) => void
  debug: (...args: any[]) => void
  getLevel?: () => string
  level?: string | (() => string)
}

function isLogLevel(value: string): value is LogLevel {
  return (Object.values(LOG_LEVELS) as string[]).includes(value)
}

// Ensures the provided logger implements the required interface.
function assertLoggerInterface(logger: LoggerInterface): void {
  Object.values(LOG_LEVELS)
    .filter((level): level is Exclude<LogLevel, 'off'> => level !== LOG_LEVELS.OFF)
    .forEach((method) => {
      if (typeof logger[method] !== 'function') {
        throw new Error(`Logger must implement method: ${method}`)
      }
    })
}

// Detect an existing log-level setting on a wrapped logger via getLevel(),
// level(), or a level string property. Returns the level or null.
function getLevelFromLogger(logger: LoggerInterface): LogLevel | null {
  if (typeof logger.getLevel === 'function') {
    const lvl = logger.getLevel()
    if (typeof lvl === 'string') {
      const lower = lvl.toLowerCase()
      if (isLogLevel(lower)) return lower
    }
  }

  if (typeof logger.level === 'function') {
    const lvl = logger.level()
    if (typeof lvl === 'string') {
      const lower = lvl.toLowerCase()
      if (isLogLevel(lower)) return lower
    }
  }

  if (typeof logger.level === 'string') {
    const lower = logger.level.toLowerCase()
    if (isLogLevel(lower)) return lower
  }

  return null
}

// Read a valid log level from the environment, or null if unset/invalid.
function getLogLevelFromEnv(): LogLevel | null {
  const envLevel = env[ENV_LOG_LEVEL] || env[`EXPO_PUBLIC_${ENV_LOG_LEVEL}`]
  if (envLevel) {
    const lower = envLevel.toLowerCase()
    if (isLogLevel(lower)) {
      return lower
    }
  }
  return null
}

// A wrapper around any logger implementing .error/.warn/.info/.debug, with
// runtime-configurable log levels and an OFF state.
export class QvacLogger {
  // Expose the available log level constants.
  static LOG_LEVELS = LOG_LEVELS

  private _logger: LoggerInterface | undefined
  private _level: LogLevel

  // If no logger is provided, defaults to OFF. Otherwise the level comes from
  // the environment, then the wrapped logger's own level, then DEFAULT_LEVEL.
  constructor(logger?: LoggerInterface) {
    this._logger = logger

    if (!this._logger) {
      this._level = LOG_LEVELS.OFF
      return
    }

    assertLoggerInterface(this._logger)

    // Environment variable takes precedence over the logger's level.
    this._level = getLogLevelFromEnv() ?? getLevelFromLogger(this._logger) ?? DEFAULT_LEVEL
  }

  setLevel(newLevel: LogLevel): void {
    if (!isLogLevel(newLevel)) {
      throw new Error(`Invalid log level: ${newLevel}`)
    }
    this._level = newLevel
  }

  getLevel(): LogLevel {
    return this._level
  }

  // Route a message to the underlying logger if its level is at or above the
  // current threshold.
  private _log(level: Exclude<LogLevel, 'off'>, ...messages: unknown[]): void {
    if (
      !this._logger ||
      this._level === LOG_LEVELS.OFF ||
      LEVEL_PRIORITIES[level] > LEVEL_PRIORITIES[this._level]
    ) {
      return
    }
    this._logger[level](...messages)
  }

  error(...msgs: unknown[]): void {
    this._log(LOG_LEVELS.ERROR, ...msgs)
  }

  warn(...msgs: unknown[]): void {
    this._log(LOG_LEVELS.WARN, ...msgs)
  }

  info(...msgs: unknown[]): void {
    this._log(LOG_LEVELS.INFO, ...msgs)
  }

  debug(...msgs: unknown[]): void {
    this._log(LOG_LEVELS.DEBUG, ...msgs)
  }
}

export default QvacLogger
