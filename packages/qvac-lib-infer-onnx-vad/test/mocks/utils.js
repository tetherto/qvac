'use strict'

// A helper function to wait a short time (to allow setImmediate callbacks to fire).
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

// A helper to listen for events on a simulated response stream.
const waitForResponse = (response, { onOutput } = {}) => {
  return new Promise((resolve, reject) => {
    if (onOutput) {
      response.on('output', onOutput)
    }
    response.on('end', () => {
      resolve(true)
    })
    response.on('error', (err) => {
      reject(err)
    })
  })
}

module.exports = {
  wait,
  waitForResponse
}
