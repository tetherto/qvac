'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonBCI extends QvacErrorBase { }

const { name, version } = require('../package.json')

const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 7001,
  FAILED_TO_CANCEL: 7002,
  FAILED_TO_APPEND: 7003,
  FAILED_TO_GET_STATUS: 7004,
  FAILED_TO_DESTROY: 7005,
  FAILED_TO_ACTIVATE: 7006,
  FAILED_TO_RESET: 7007,
  FAILED_TO_PAUSE: 7008,
  INVALID_NEURAL_INPUT: 7009,
  JOB_ALREADY_RUNNING: 7010,
  MODEL_NOT_LOADED: 7011
})

addCodes({
  [ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
    name: 'FAILED_TO_LOAD_WEIGHTS',
    message: (message) => `Failed to load weights, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_CANCEL]: {
    name: 'FAILED_TO_CANCEL',
    message: (message) => `Failed to cancel inference, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_APPEND]: {
    name: 'FAILED_TO_APPEND',
    message: (message) => `Failed to append data to processing queue, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_GET_STATUS]: {
    name: 'FAILED_TO_GET_STATUS',
    message: (message) => `Failed to get addon status, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_DESTROY]: {
    name: 'FAILED_TO_DESTROY',
    message: (message) => `Failed to destroy instance, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_ACTIVATE]: {
    name: 'FAILED_TO_ACTIVATE',
    message: (message) => `Failed to activate model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_RESET]: {
    name: 'FAILED_TO_RESET',
    message: (message) => `Failed to reset model state, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_PAUSE]: {
    name: 'FAILED_TO_PAUSE',
    message: (message) => `Failed to pause inference, error: ${message}`
  },
  [ERR_CODES.INVALID_NEURAL_INPUT]: {
    name: 'INVALID_NEURAL_INPUT',
    message: (message) => `Invalid neural signal input: ${message}`
  },
  [ERR_CODES.JOB_ALREADY_RUNNING]: {
    name: 'JOB_ALREADY_RUNNING',
    message: () => 'Cannot set new job: a job is already set or being processed'
  },
  [ERR_CODES.MODEL_NOT_LOADED]: {
    name: 'MODEL_NOT_LOADED',
    message: () => 'Model is not loaded'
  }
}, {
  name,
  version
})

module.exports = {
  ERR_CODES,
  QvacErrorAddonBCI
}
