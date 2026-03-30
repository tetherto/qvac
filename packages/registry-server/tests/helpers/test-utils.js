'use strict'

const tmp = require('test-tmp')

// Create a temporary storage directory for tests
async function createTempStorage (t) {
  return await tmp(t)
}

// Wait for a condition to be true
async function waitFor (condition, timeout = 5000, interval = 100) {
  const start = Date.now()

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }

  throw new Error('Timeout waiting for condition')
}

module.exports = {
  createTempStorage,
  waitFor
}
