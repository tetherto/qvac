'use strict'

/**
 * Test Mock Utilities
 *
 * Helper functions for mock objects and unit tests.
 *
 * Exports:
 *   - transitionCb: Callback for logging state transitions
 *   - wait: Promise-based delay helper for async tests
 *
 * Used by: test/mocks/*.js, test/unit/*.test.js
 */

const transitionCb = (instance, newState) => {
  console.log(`State transitioned to: ${newState}`)
}

// A helper function to wait a short time (to allow setImmediate callbacks to fire)
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

module.exports = {
  transitionCb,
  wait
}
