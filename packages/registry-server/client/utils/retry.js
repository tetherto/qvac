'use strict'

/**
 * Executes an async function with automatic retry on specific error codes.
 *
 * @param {() => Promise<unknown>} fn - The async operation to attempt
 * @param {object} opts
 * @param {number} [opts.maxRetries=3] - Maximum number of attempts (including the first)
 * @param {string[]} [opts.retryCodes=[]] - Error codes that trigger a retry
 * @param {() => Promise<void>} [opts.onRetry] - Called before each retry attempt (e.g. cleanup)
 * @param {() => Promise<void>} [opts.beforeRetry] - Awaited before the next attempt runs.
 *   Use to re-establish prerequisites (e.g. wait for peers to reconnect) so the
 *   retry doesn't immediately fail again against a dead connection.
 * @param {{ warn: Function }} [opts.logger] - Logger instance for retry warnings
 * @returns {Promise<unknown>}
 */
async function withRetry (fn, opts = {}) {
  const { maxRetries = 3, retryCodes = [], onRetry, beforeRetry, logger } = opts

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isRetriable = retryCodes.length > 0 && retryCodes.includes(err && err.code)
      if (!isRetriable || attempt >= maxRetries) throw err
      logger && logger.warn(`Retrying after ${err.code} (attempt ${attempt}/${maxRetries}): ${err.message}`)
      if (onRetry) await onRetry()
      if (beforeRetry) await beforeRetry()
    }
  }
}

module.exports = { withRetry }
