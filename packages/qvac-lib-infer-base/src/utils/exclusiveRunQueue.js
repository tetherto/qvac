'use strict'

/**
 * Creates a serialized execution queue. Calls to the returned function
 * are guaranteed to run one at a time, in order, even when fired concurrently.
 *
 * @returns {function(fn: () => Promise<T>): Promise<T>} A function that accepts
 *   an async thunk and returns its result after all previously queued thunks complete.
 *
 * @example
 *   const run = exclusiveRunQueue()
 *   const responseA = run(() => addon.runJob(inputA))
 *   const responseB = run(() => addon.runJob(inputB)) // waits for A
 */
function exclusiveRunQueue () {
  let waiter = Promise.resolve()

  return async function run (fn) {
    const prev = waiter
    let release
    waiter = new Promise(resolve => { release = resolve })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

module.exports = exclusiveRunQueue
