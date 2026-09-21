/* eslint-disable @typescript-eslint/no-explicit-any -- Preserve the published untyped queue callback contract. */

/**
 * Creates a serialized execution queue. Calls to the returned function
 * are guaranteed to run one at a time, in order, even when fired concurrently.
 */
function exclusiveRunQueue(): (fn: () => Promise<any>) => Promise<any> {
  let waiter = Promise.resolve()

  return async function run(fn: () => Promise<any>): Promise<any> {
    const previous = waiter
    let release!: () => void
    waiter = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

export = exclusiveRunQueue
