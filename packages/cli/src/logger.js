const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
}

export function createLogger (level = 'info') {
  if (!(level in LOG_LEVELS)) {
    const validLevels = Object.keys(LOG_LEVELS).join(', ')
    console.warn(`Invalid log level "${level}", falling back to "info". Valid levels: ${validLevels}`)
  }

  const currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info

  return {
    error (message) {
      if (currentLevel >= LOG_LEVELS.error) {
        console.error(message)
      }
    },
    warn (message) {
      if (currentLevel >= LOG_LEVELS.warn) {
        console.warn(message)
      }
    },
    info (message) {
      if (currentLevel >= LOG_LEVELS.info) {
        console.log(message)
      }
    },
    debug (message) {
      if (currentLevel >= LOG_LEVELS.debug) {
        console.debug(message)
      }
    }
  }
}
