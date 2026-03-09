const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
} as const

type LogLevel = keyof typeof LOG_LEVELS

export interface Logger {
  error: (message: string) => void
  warn: (message: string) => void
  info: (message: string) => void
  debug: (message: string) => void
}

export function createLogger (level: string = 'info'): Logger {
  if (!(level in LOG_LEVELS)) {
    const validLevels = Object.keys(LOG_LEVELS).join(', ')
    console.warn(`Invalid log level "${level}", falling back to "info". Valid levels: ${validLevels}`)
  }

  const currentLevel = LOG_LEVELS[level as LogLevel] ?? LOG_LEVELS.info

  return {
    error (message: string) {
      if (currentLevel >= LOG_LEVELS.error) {
        console.error(message)
      }
    },
    warn (message: string) {
      if (currentLevel >= LOG_LEVELS.warn) {
        console.warn(message)
      }
    },
    info (message: string) {
      if (currentLevel >= LOG_LEVELS.info) {
        console.log(message)
      }
    },
    debug (message: string) {
      if (currentLevel >= LOG_LEVELS.debug) {
        console.debug(message)
      }
    }
  }
}
