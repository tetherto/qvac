'use strict'

const { QvacErrorBase, addCodes } = require('@tetherto/qvac-lib-error-base')
const { name, version } = require('../package.json')

class QvacErrorAddonSileroVad extends QvacErrorBase {}

// This library has error code range from 10,001 to 11,000
const ERR_CODES = Object.freeze({
  FAILED_TO_ACTIVATE: 10001,
  FAILED_TO_PAUSE: 10002,
  FAILED_TO_CANCEL: 10003,
  FAILED_TO_STOP: 10004,
  FAILED_TO_APPEND: 10005,
  FAILED_TO_GET_STATUS: 10006,
  FAILED_TO_DESTROY: 10007,
  DATA_NOT_ARRAY_BUFFER: 10008,
  FAILED_TO_CREATE_INSTANCE: 10009
})

addCodes({
  [ERR_CODES.FAILED_TO_ACTIVATE]: {
    name: 'FAILED_TO_ACTIVATE',
    message: (message) => `Failed to activate model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_PAUSE]: {
    name: 'FAILED_TO_PAUSE',
    message: (message) => `Failed to pause inference, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_CANCEL]: {
    name: 'FAILED_TO_CANCEL',
    message: (message) => `Failed to cancel inference, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_STOP]: {
    name: 'FAILED_TO_STOP',
    message: (message) => `Failed to stop inference, error: ${message}`
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
  [ERR_CODES.DATA_NOT_ARRAY_BUFFER]: {
    name: 'DATA_NOT_ARRAY_BUFFER',
    message: 'Data input must be an ArrayBuffer'
  },
  [ERR_CODES.FAILED_TO_CREATE_INSTANCE]: {
    name: 'FAILED_TO_CREATE_INSTANCE',
    message: 'Failed to create VAD instance'
  }
}, {
  name, version
})

module.exports = {
  ERR_CODES,
  QvacErrorAddonSileroVad
}
