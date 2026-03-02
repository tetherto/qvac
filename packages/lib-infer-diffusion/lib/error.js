'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonDiffusion extends QvacErrorBase { }

const { name, version } = require('../package.json')

const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD: 8001,
  FAILED_TO_ACTIVATE: 8002,
  FAILED_TO_RUN: 8003,
  FAILED_TO_CANCEL: 8004,
  FAILED_TO_UNLOAD: 8005,
  FAILED_TO_DESTROY: 8006,
  INVALID_PARAMS: 8007
})

addCodes({
  [ERR_CODES.FAILED_TO_LOAD]: {
    name: 'FAILED_TO_LOAD',
    message: (message) => `Failed to load model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_ACTIVATE]: {
    name: 'FAILED_TO_ACTIVATE',
    message: (message) => `Failed to activate model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_RUN]: {
    name: 'FAILED_TO_RUN',
    message: (message) => `Failed to run generation, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_CANCEL]: {
    name: 'FAILED_TO_CANCEL',
    message: (message) => `Failed to cancel generation, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_UNLOAD]: {
    name: 'FAILED_TO_UNLOAD',
    message: (message) => `Failed to unload model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_DESTROY]: {
    name: 'FAILED_TO_DESTROY',
    message: (message) => `Failed to destroy instance, error: ${message}`
  },
  [ERR_CODES.INVALID_PARAMS]: {
    name: 'INVALID_PARAMS',
    message: (message) => `Invalid generation parameters: ${message}`
  }
}, {
  name,
  version
})

module.exports = {
  ERR_CODES,
  QvacErrorAddonDiffusion
}
