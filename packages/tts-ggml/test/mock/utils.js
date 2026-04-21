'use strict'

// A helper function to wait a short time (to allow setImmediate callbacks to fire).
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

// Transition callback to log state changes.
const transitionCb = (instance, newState) => {
  console.log(`Transitioned to: ${newState}`)
}

module.exports = {
  wait,
  transitionCb
}
