import QvacLogger, { type LogLevel } from '@qvac/logging'
import { LOG_LEVELS } from '@qvac/logging/constants'
import { sendLogToStreams } from '../engine/state/logging-stream-registry'
import { isLevelEnabled, formatArg } from './utils'
import { LOG_ID, LOG_NAMESPACE } from './namespaces'
import type { Logger, LoggerOptions, LogTransport } from './types'

// A single instance is shared across every evaluation of this module via
// globalThis so that log level and console toggles reach all loggers even if
// the module is evaluated more than once.
const REGISTRY_KEY = Symbol.for('@qvac/core:logger-registry')
const GLOBAL_LEVEL_KEY = Symbol.for('@qvac/core:global-log-level')
const GLOBAL_CONSOLE_KEY = Symbol.for('@qvac/core:global-console-output')
const LOGGER_CACHE_KEY = Symbol.for('@qvac/core:logger-cache')
const APP_LOGGER_KEY = Symbol.for('@qvac/core:app-logger')
const ENGINE_LOGGER_KEY = Symbol.for('@qvac/core:engine-logger')

type GlobalState = {
  [REGISTRY_KEY]?: Set<Logger>
  [GLOBAL_LEVEL_KEY]?: LogLevel
  [GLOBAL_CONSOLE_KEY]?: boolean
  [LOGGER_CACHE_KEY]?: Map<string, Logger>
  [APP_LOGGER_KEY]?: Logger
  [ENGINE_LOGGER_KEY]?: Logger
}

function getGlobal(): GlobalState {
  return globalThis as GlobalState
}

function getRegistry(): Set<Logger> {
  const global = getGlobal()
  if (!global[REGISTRY_KEY]) {
    global[REGISTRY_KEY] = new Set<Logger>()
  }
  return global[REGISTRY_KEY]
}

export function registerLogger(logger: Logger) {
  const global = getGlobal()
  getRegistry().add(logger)

  if (global[GLOBAL_LEVEL_KEY] !== undefined) {
    logger.setLevel(global[GLOBAL_LEVEL_KEY])
  }
  if (global[GLOBAL_CONSOLE_KEY] !== undefined) {
    logger.setConsoleOutput(global[GLOBAL_CONSOLE_KEY])
  }
}

export function unregisterLogger(logger: Logger) {
  getRegistry().delete(logger)
}

export function setGlobalLogLevel(level: LogLevel) {
  getGlobal()[GLOBAL_LEVEL_KEY] = level
  for (const logger of getRegistry()) {
    logger.setLevel(level)
  }
}

export function setGlobalConsoleOutput(enabled: boolean) {
  getGlobal()[GLOBAL_CONSOLE_KEY] = enabled
  for (const logger of getRegistry()) {
    logger.setConsoleOutput(enabled)
  }
}

interface LoggerExtensions {
  onLog?: (level: LogLevel, namespace: string, message: string) => void
}

function safeTransport(transport: LogTransport, namespace: string): LogTransport {
  return (level, ns, message) => {
    try {
      const result = transport(level, ns, message)
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.error(`Transport error in ${namespace}:`, error) // fallback (avoid recursion)
        })
      }
    } catch (error: unknown) {
      console.error(`Transport error in ${namespace}:`, error) // fallback (avoid recursion)
    }
  }
}

export function createBaseLogger(
  namespace: string,
  options?: LoggerOptions,
  extensions?: LoggerExtensions
): Logger {
  const qvacLogger = new QvacLogger(console)

  const initialLevel = options?.level ?? LOG_LEVELS.INFO
  qvacLogger.setLevel(initialLevel)

  const transports = options?.transports || []
  let consoleEnabled = options?.enableConsole !== false

  const log = (level: LogLevel, ...args: unknown[]) => {
    if (!isLevelEnabled(level, qvacLogger.getLevel())) {
      return
    }

    const message = args.map(formatArg).join(' ')

    if (consoleEnabled) {
      switch (level) {
        case LOG_LEVELS.ERROR:
          qvacLogger.error(`[${namespace}]`, ...args)
          break
        case LOG_LEVELS.WARN:
          qvacLogger.warn(`[${namespace}]`, ...args)
          break
        case LOG_LEVELS.INFO:
          qvacLogger.info(`[${namespace}]`, ...args)
          break
        case LOG_LEVELS.DEBUG:
          qvacLogger.debug(`[${namespace}]`, ...args)
          break
      }
    }

    extensions?.onLog?.(level, namespace, message)

    for (const transport of transports) {
      try {
        const result = transport(level, namespace, message)
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            console.error(`Transport error in ${namespace}:`, error) // fallback (avoid recursion)
          })
        }
      } catch (error: unknown) {
        console.error(`Transport error in ${namespace}:`, error) // fallback (avoid recursion)
      }
    }
  }

  const logger: Logger = {
    error: (...args: unknown[]) => log(LOG_LEVELS.ERROR, ...args),
    warn: (...args: unknown[]) => log(LOG_LEVELS.WARN, ...args),
    info: (...args: unknown[]) => log(LOG_LEVELS.INFO, ...args),
    debug: (...args: unknown[]) => log(LOG_LEVELS.DEBUG, ...args),
    trace: (...args: unknown[]) => log(LOG_LEVELS.DEBUG, ...args),
    setLevel: (level: LogLevel) => qvacLogger.setLevel(level),
    getLevel: (): LogLevel => qvacLogger.getLevel(),
    addTransport: (transport) => {
      transports.push(transport)
    },
    setConsoleOutput: (enabled: boolean) => {
      consoleEnabled = enabled
    }
  }

  registerLogger(logger)

  return logger
}

function createLogger(namespace: string, options?: LoggerOptions): Logger {
  const safeOptions = options
    ? {
        ...options,
        transports: options.transports?.map((t) => safeTransport(t, namespace)) || []
      }
    : undefined

  return createBaseLogger(namespace, safeOptions)
}

/**
 * Creates or retrieves a namespaced logger instance.
 *
 * Loggers are cached per namespace when `options` is omitted, so repeated
 * calls with the same namespace return the same instance. When `options` is
 * supplied, a fresh logger is returned and the cache is bypassed.
 *
 * @param namespace - Namespace used to prefix log messages from this logger (e.g. `"my-app"`, `"@qvac/core:embed"`).
 * @param options - Optional logger configuration (custom transports, log level, etc.). When provided, a new logger is always constructed.
 * @returns A `Logger` instance scoped to `namespace`.
 */
export function getLogger(namespace: string, options?: LoggerOptions): Logger {
  const global = getGlobal()
  if (!global[LOGGER_CACHE_KEY]) {
    global[LOGGER_CACHE_KEY] = new Map()
  }
  const cache = global[LOGGER_CACHE_KEY]

  if (!options) {
    const cached = cache.get(namespace)
    if (cached) {
      return cached
    }
  }
  const logger = createLogger(namespace, options)
  if (!options) {
    cache.set(namespace, logger)
  }
  return logger
}

/**
 * Builds a logger whose every line is published to the log stream registered
 * under `id`, letting subscribers observe it live. Console output is off by
 * default; callers opt back in through `options`.
 */
export function createStreamLogger(id: string, namespace: string, options?: LoggerOptions): Logger {
  return createBaseLogger(
    namespace,
    {
      enableConsole: false,
      ...options
    },
    {
      onLog: (level, ns, message) => {
        sendLogToStreams(id, level, ns, message)
      }
    }
  )
}

/**
 * The library's own operational logger. Its lines flow to the {@link LOG_ID}
 * stream (and the {@link ALL_LOG_ID} fan-in), so a subscriber can watch what the
 * engine and its addons are doing. Cached when called without options.
 */
export function getEngineLogger(options?: LoggerOptions): Logger {
  const global = getGlobal()
  if (!options && global[ENGINE_LOGGER_KEY]) {
    return global[ENGINE_LOGGER_KEY]
  }

  const logger = createStreamLogger(LOG_ID, LOG_NAMESPACE, options)

  if (!options) {
    global[ENGINE_LOGGER_KEY] = logger
  }

  return logger
}

/**
 * The application-facing logger for the public API surface. Its lines stay off
 * the log stream and, by default, off the console — the caller opts in through
 * `options`. Cached when called without options.
 */
export function getAppLogger(options?: LoggerOptions): Logger {
  const global = getGlobal()
  if (!options && global[APP_LOGGER_KEY]) {
    return global[APP_LOGGER_KEY]
  }

  const logger = getLogger('app', { enableConsole: false, ...options })

  if (!options) {
    global[APP_LOGGER_KEY] = logger
  }

  return logger
}
