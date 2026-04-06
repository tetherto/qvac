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

  return {
    /**
     * Creates a new QvacResponse and stores it as the active response.
     * If a previous response is still active, it is failed with a stale-job error
     * before the new one is created.
     *
     * @returns {QvacResponse}
     */
    start () {
      if (active) {
        active.failed(new Error('Stale job replaced by new run'))
        active = null
      }

      const response = new QvacResponse({
        cancelHandler: () => opts.cancel()
      })

      active = response
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
