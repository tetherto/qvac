'use strict'

const QvacResponse = require('../QvacResponse')

/**
 * Creates a single-job handler that manages the lifecycle of a QvacResponse.
 * Replaces the _jobToResponse Map / _saveJobToResponseMapping / _deleteJobMapping
 * boilerplate used by every addon.
 *
 * @param {Object} opts
 * @param {Function} opts.cancel - Called when the consumer cancels the active response.
 * @returns {{ start, output, end, fail, active }}
 *
 * @example
 *   // In addon constructor:
 *   this._job = createJobHandler({ cancel: () => this.addon.cancel() })
 *
 *   // In run method:
 *   const response = this._job.start()
 *   await this.addon.runJob(input)
 *   return response
 *
 *   // In output callback:
 *   this._job.output(data)
 *   this._job.end(stats)
 */
function createJobHandler (opts) {
  let active = null

  // Clears `active` whenever the response settles (end / fail / abort), not
  // only on explicit end()/fail(). Identity-guarded against stale-replace
  // races so a late settle on a stale response can't clobber a newer active.
  const bindCleanup = (response) => {
    const clearIfCurrent = () => {
      if (active === response) active = null
    }
    response.onFinish(clearIfCurrent)
    response.onError(clearIfCurrent)
  }

  return {
    /**
     * Creates a new QvacResponse and stores it as the active response.
     * If a previous response is still active, it is failed with a stale-job error
     * before the new one is created.
     *
     * @param {Object} [runOpts]
     * @param {AbortSignal} [runOpts.signal] - Forwarded to the underlying `QvacResponse`.
     *   Typically the per-call signal from `model.run(input, { signal })`. When aborted, the
     *   abort `reason` becomes the response error (passed through unchanged when it's an Error).
     * @returns {QvacResponse}
     */
    start (runOpts) {
      if (active) {
        active.failed(new Error('Stale job replaced by new run'))
        active = null
      }

      const response = new QvacResponse({
        cancelHandler: () => opts.cancel(),
        signal: runOpts && runOpts.signal
      })

      active = response
      bindCleanup(response)
      return response
    },

    /**
     * Registers a pre-built response (e.g. a custom subclass) as the active response.
     * If a previous response is still active, it is failed with a stale-job error.
     * Use this instead of start() when you need a QvacResponse subclass.
     *
     * @param {QvacResponse} response
     * @returns {QvacResponse} The same response, for convenience.
     */
    startWith (response) {
      if (active) {
        active.failed(new Error('Stale job replaced by new run'))
        active = null
      }

      active = response
      bindCleanup(response)
      return response
    },

    /**
     * Routes output data to the active response.
     * No-op if no active response (defensive guard).
     *
     * @param {*} data
     */
    output (data) {
      if (!active) return
      active.updateOutput(data)
    },

    /**
     * Ends the active response. Optionally forwards stats before ending.
     * Clears the active response.
     *
     * @param {*} [stats] - If provided (non-null), forwarded via updateStats() before ending.
     * @param {*} [result] - If provided, passed to ended(result). Otherwise ended() uses default (output array).
     */
    end (stats, result) {
      if (!active) return
      const ref = active
      active = null
      if (stats != null) {
        ref.updateStats(stats)
      }
      if (result !== undefined) {
        ref.ended(result)
      } else {
        ref.ended()
      }
    },

    /**
     * Fails the active response with an error. Clears the active response.
     *
     * @param {Error|string} error
     */
    fail (error) {
      if (!active) return
      const ref = active
      active = null
      ref.failed(error)
    },

    /**
     * Returns the current active QvacResponse, or null if idle.
     * @type {QvacResponse|null}
     */
    get active () {
      return active
    }
  }
}

module.exports = createJobHandler
