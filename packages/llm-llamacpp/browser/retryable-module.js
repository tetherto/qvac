'use strict'

function retryableModule(factory) {
  let pending = null

  function load() {
    if (!pending) {
      const current = Promise.resolve().then(factory)
      pending = current
      current.catch(() => {
        if (pending === current) pending = null
      })
    }
    return pending
  }

  load.reset = () => {
    pending = null
  }

  return load
}

module.exports = retryableModule
