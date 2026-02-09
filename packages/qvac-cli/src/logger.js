/**
 * Creates a logger with the specified log level.
 * @param {"quiet" | "normal" | "verbose"} logLevel
 */
export function createLogger (logLevel) {
  return {
    log (message, level = 'normal') {
      if (logLevel === 'quiet' && level !== 'quiet') return
      if (level === 'verbose' && logLevel !== 'verbose') return
      console.log(message)
    },
    verbose (message) {
      if (logLevel === 'verbose') {
        console.log(message)
      }
    }
  }
}
