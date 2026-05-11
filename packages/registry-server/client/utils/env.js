'use strict'

function getEnv (key, defaultValue = undefined) {
  if (typeof process !== 'undefined' && process.env && process.env[key] !== undefined) {
    return process.env[key]
  }
  return defaultValue
}

module.exports = {
  getEnv
}
