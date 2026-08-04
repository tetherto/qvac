"use strict";
/* eslint-disable @typescript-eslint/no-explicit-any -- Preserve the published untyped queue callback contract. */
/**
 * Creates a serialized execution queue. Calls to the returned function
 * are guaranteed to run one at a time, in order, even when fired concurrently.
 */
function exclusiveRunQueue() {
    let waiter = Promise.resolve();
    return async function run(fn) {
        const previous = waiter;
        let release;
        waiter = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await fn();
        }
        finally {
            release();
        }
    };
}
module.exports = exclusiveRunQueue;
