/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- Preserve the published untyped CommonJS job payload contract. */

import QvacResponse = require('../QvacResponse')

interface CreateJobHandlerOptions {
  cancel: () => void | Promise<void>
}

interface JobHandler {
  start(runOpts?: { signal?: QvacResponse.AbortSignalLike }): QvacResponse
  startWith(response: QvacResponse): QvacResponse
  output(data: any): void
  end(stats?: any, result?: any): void
  fail(error: Error | string): void
  readonly active: QvacResponse | null
}

/**
 * Creates a single-job handler that manages the lifecycle of a QvacResponse.
 * Replaces the _jobToResponse Map / _saveJobToResponseMapping / _deleteJobMapping
 * boilerplate used by every addon.
 */
function createJobHandler(opts: CreateJobHandlerOptions): JobHandler {
  let active: QvacResponse | null = null

  // Clears `active` whenever the response settles (end / fail / abort), not
  // only on explicit end()/fail(). Identity-guarded against stale-replace
  // races so a late settle on a stale response can't clobber a newer active.
  // Registered as a settlement hook, not as 'end'/'error' listeners: hooks
  // run before public listeners, so a prepended listener that throws cannot
  // abort the emit loop ahead of this cleanup and leave a settled response
  // active.
  const bindCleanup = (response: QvacResponse) => {
    response._onSettled(() => {
      if (active === response) active = null
    })
  }

  return {
    /**
     * Creates a new QvacResponse and stores it as the active response.
     * If a previous response is still active, it is failed with a stale-job error
     * before the new one is created.
     */
    start(runOpts?: { signal?: QvacResponse.AbortSignalLike }): QvacResponse {
      if (active) {
        active.failed(new Error('Stale job replaced by new run'))
        active = null
      }

      const response = new QvacResponse({
        cancelHandler: (() => opts.cancel()) as () => Promise<void>,
        signal: runOpts?.signal
      })

      active = response
      bindCleanup(response)
      return response
    },

    /**
     * Registers a pre-built response (e.g. a custom subclass) as the active response.
     * If a previous response is still active, it is failed with a stale-job error.
     * Use this instead of start() when you need a QvacResponse subclass.
     */
    startWith(response: QvacResponse): QvacResponse {
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
     */
    output(data: any): void {
      if (!active) return
      active.updateOutput(data)
    },

    /**
     * Ends the active response. Optionally forwards stats before ending.
     * Clears the active response.
     */
    end(stats?: any, result?: any): void {
      if (!active) return
      const ref = active
      active = null
      try {
        if (stats != null) {
          ref.updateStats(stats)
        }
      } finally {
        if (result !== undefined) {
          ref.ended(result)
        } else {
          ref.ended()
        }
      }
    },

    /**
     * Fails the active response with an error. Clears the active response.
     */
    fail(error: Error | string): void {
      if (!active) return
      const ref = active
      active = null
      ref.failed(error as Error)
    },

    /**
     * Returns the current active QvacResponse, or null if idle.
     */
    get active(): QvacResponse | null {
      return active
    }
  }
}

export = createJobHandler
