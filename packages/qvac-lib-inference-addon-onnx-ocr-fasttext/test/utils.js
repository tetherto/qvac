'use strict'

const transitionCb = (instance, newState) => {
  console.log(`State transitioned to: ${newState}`)
}

// A helper function to wait a short time (to allow setImmediate callbacks to fire)
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

module.exports = {
  transitionCb,
  wait
}
