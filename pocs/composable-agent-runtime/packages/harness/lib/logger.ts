import QvacLogger, { type LogLevel } from '@qvac/logging'
import type { HarnessLoggingConfig } from './types.ts'

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'off']
const LOGGING_ARG_PREFIX = '--logging='

export function createHarnessLogger(logging?: HarnessLoggingConfig): QvacLogger {
  const write = (...values: unknown[]) => console.error(...values)
  const logger = new QvacLogger({
    error: write,
    warn: write,
    info: write,
    debug: write
  })
  logger.setLevel(logging?.level ?? 'info')
  return logger
}

// --debug is sugar for --logging=debug, the common case; any level can still
// be passed explicitly (e.g. --logging=off, --logging=error).
export function loggingFromArgv(argv: readonly string[]): HarnessLoggingConfig {
  const explicit = argv
    .find((value) => value.startsWith(LOGGING_ARG_PREFIX))
    ?.slice(LOGGING_ARG_PREFIX.length)
  if (explicit !== undefined && isLogLevel(explicit)) return { level: explicit }
  return argv.includes('--debug') ? { level: 'debug' } : {}
}

export function argvForLogging(logging?: HarnessLoggingConfig): string[] {
  if (!logging?.level) return []
  return logging.level === 'debug' ? ['--debug'] : [`${LOGGING_ARG_PREFIX}${logging.level}`]
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}
