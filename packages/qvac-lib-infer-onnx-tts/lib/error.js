'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonTTS extends QvacErrorBase { }

const { name, version } = require('../package.json')

// This library has error code range from 7001 to 7011
const ERR_CODES = Object.freeze({
  FAILED_TO_ACTIVATE: 7001,
  FAILED_TO_APPEND: 7002,
  FAILED_TO_GET_STATUS: 7003,
  FAILED_TO_PAUSE: 7004,
  FAILED_TO_CANCEL: 7005,
  FAILED_TO_DESTROY: 7006,
  FAILED_TO_UNLOAD: 7007,
  FAILED_TO_LOAD: 7008,
  FAILED_TO_RELOAD: 7009,
  FAILED_TO_STOP: 7010,
  JOB_ALREADY_RUNNING: 7011
})

addCodes({
  [ERR_CODES.FAILED_TO_ACTIVATE]: {
    name: 'FAILED_TO_ACTIVATE',
    message: (message) => `Failed to activate model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_APPEND]: {
    name: 'FAILED_TO_APPEND',
    message: (message) => `Failed to append data to processing queue, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_GET_STATUS]: {
    name: 'FAILED_TO_GET_STATUS',
    message: (message) => `Failed to get addon status, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_PAUSE]: {
    name: 'FAILED_TO_PAUSE',
    message: (message) => `Failed to pause inference, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_CANCEL]: {
    name: 'FAILED_TO_CANCEL',
    message: (message) => `Failed to cancel inference, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_DESTROY]: {
    name: 'FAILED_TO_DESTROY',
    message: (message) => `Failed to destroy instance, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_UNLOAD]: {
    name: 'FAILED_TO_UNLOAD',
    message: (message) => `Failed to unload model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_LOAD]: {
    name: 'FAILED_TO_LOAD',
    message: (message) => `Failed to load model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_RELOAD]: {
    name: 'FAILED_TO_RELOAD',
    message: (message) => `Failed to reload model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_STOP]: {
    name: 'FAILED_TO_STOP',
    message: (message) => `Failed to stop inference, error: ${message}`
  },
  [ERR_CODES.JOB_ALREADY_RUNNING]: {
    name: 'JOB_ALREADY_RUNNING',
    message: () => 'Cannot set new job: a job is already set or being processed'
  }
}, {
  name,
  version
})

module.exports = {
  ERR_CODES,
  QvacErrorAddonTTS
}
