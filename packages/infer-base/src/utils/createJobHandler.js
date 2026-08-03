"use strict";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- Preserve the published untyped CommonJS job payload contract. */
const QvacResponse = require("../QvacResponse");
/**
 * Creates a single-job handler that manages the lifecycle of a QvacResponse.
 * Replaces the _jobToResponse Map / _saveJobToResponseMapping / _deleteJobMapping
 * boilerplate used by every addon.
 */
function createJobHandler(opts) {
    let active = null;
    // Clears `active` whenever the response settles (end / fail / abort), not
    // only on explicit end()/fail(). Identity-guarded against stale-replace
    // races so a late settle on a stale response can't clobber a newer active.
    // Registered as a settlement hook, not as 'end'/'error' listeners: hooks
    // run before public listeners, so a prepended listener that throws cannot
    // abort the emit loop ahead of this cleanup and leave a settled response
    // active.
    const bindCleanup = (response) => {
        response._onSettled(() => {
            if (active === response)
                active = null;
        });
    };
    return {
        /**
         * Creates a new QvacResponse and stores it as the active response.
         * If a previous response is still active, it is failed with a stale-job error
         * before the new one is created.
         */
        start(runOpts) {
            if (active) {
                active.failed(new Error('Stale job replaced by new run'));
                active = null;
            }
            const response = new QvacResponse({
                cancelHandler: (() => opts.cancel()),
                signal: runOpts?.signal
            });
            active = response;
            bindCleanup(response);
            return response;
        },
        /**
         * Registers a pre-built response (e.g. a custom subclass) as the active response.
         * If a previous response is still active, it is failed with a stale-job error.
         * Use this instead of start() when you need a QvacResponse subclass.
         */
        startWith(response) {
            if (active) {
                active.failed(new Error('Stale job replaced by new run'));
                active = null;
            }
            active = response;
            bindCleanup(response);
            return response;
        },
        /**
         * Routes output data to the active response.
         * No-op if no active response (defensive guard).
         */
        output(data) {
            if (!active)
                return;
            active.updateOutput(data);
        },
        /**
         * Ends the active response. Optionally forwards stats before ending.
         * Clears the active response.
         */
        end(stats, result) {
            if (!active)
                return;
            const ref = active;
            active = null;
            try {
                if (stats != null) {
                    ref.updateStats(stats);
                }
            }
            finally {
                if (result !== undefined) {
                    ref.ended(result);
                }
                else {
                    ref.ended();
                }
            }
        },
        /**
         * Fails the active response with an error. Clears the active response.
         */
        fail(error) {
            if (!active)
                return;
            const ref = active;
            active = null;
            ref.failed(error);
        },
        /**
         * Returns the current active QvacResponse, or null if idle.
         */
        get active() {
            return active;
        }
    };
}
module.exports = createJobHandler;
