import QvacLogger from '@qvac/logging'
import { getOptionalConfigSnapshot } from '@qvac/config'
import { harnessLogLevel, resolveHarnessConfig } from './config.ts'
import type { HarnessLoggingConfig } from './types.ts'

export function createHarnessLogger(logging?: HarnessLoggingConfig): QvacLogger {
  const write = (...values: unknown[]) => console.error(...values)
  const logger = new QvacLogger({
    error: write,
    warn: write,
    info: write,
    debug: write
  })
  const config =
    getOptionalConfigSnapshot() ?? resolveHarnessConfig(logging)
  logger.setLevel(harnessLogLevel(config))
  return logger
}
