'use strict'

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function transitionCb (instance, state) {
  console.log(`[mock] state → ${state}`)
}

module.exports = {
  wait,
  transitionCb
}
