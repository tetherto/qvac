'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')
const { name, version } = require('../package.json')

class QvacErrorRegistryClient extends QvacErrorBase { }

// This library has error code range from 19,001 to 20,000
const ERR_CODES = Object.freeze({
  FAILED_TO_CONNECT: 19001,
  FAILED_TO_CLOSE: 19002,
  MODEL_NOT_FOUND: 19003
})

addCodes({
  [ERR_CODES.FAILED_TO_CONNECT]: {
    name: 'FAILED_TO_CONNECT',
    message: (message) => `Failed to connect to registry, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_CLOSE]: {
    name: 'FAILED_TO_CLOSE',
    message: (message) => `Failed to close registry, error: ${message}`
  },
  [ERR_CODES.MODEL_NOT_FOUND]: {
    name: 'MODEL_NOT_FOUND',
    message: (message) => `Model not found, error: ${message}`
  }
}, {
  name,
  version
})

module.exports = {
  ERR_CODES,
  QvacErrorRegistryClient
}
