'use strict'

function exclusiveRunQueue () {
  let waiter = Promise.resolve()

  return async function withExclusiveRun (fn) {
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
