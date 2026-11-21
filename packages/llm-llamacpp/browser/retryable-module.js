'use strict'

function retryableModule(factory) {
  let pending = null

  return function () {
    if (!pending) {
      const current = Promise.resolve().then(factory)
      pending = current
      current.catch(() => {
        if (pending === current) pending = null
      })
    }
    return pending
  }
}

module.exports = retryableModule
