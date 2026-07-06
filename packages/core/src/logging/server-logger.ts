import { createStreamLogger } from './stream-logger'
import type { Logger, LoggerOptions } from './types'
import { CORE_LOG_ID, CORE_NAMESPACE } from './namespaces'

let cachedLogger: Logger | null = null

export function getServerLogger(options?: LoggerOptions): Logger {
  if (!options && cachedLogger) {
    return cachedLogger
  }

  const logger = createStreamLogger(CORE_LOG_ID, CORE_NAMESPACE, options)

  if (!options) {
    cachedLogger = logger
  }

  return logger
}
