'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonWhisper extends QvacErrorBase { }

const { name, version } = require('../package.json')

// This library has error code range from 6001 to 6011
const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 6001,
  FAILED_TO_CANCEL: 6002,
  FAILED_TO_APPEND: 6003,
  FAILED_TO_GET_STATUS: 6004,
  FAILED_TO_DESTROY: 6005,
  FAILED_TO_ACTIVATE: 6006,
  FAILED_TO_RESET: 6007,
  FAILED_TO_PAUSE: 6008,
  VAD_MODEL_REQUIRED: 6009,
  JOB_ALREADY_RUNNING: 6010,
  INVALID_AUDIO_INPUT: 6011
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
  [ERR_CODES.VAD_MODEL_REQUIRED]: {
    name: 'VAD_MODEL_REQUIRED',
    message: () => 'VAD model name is required for Whisper transcription'
  },
  [ERR_CODES.JOB_ALREADY_RUNNING]: {
    name: 'JOB_ALREADY_RUNNING',
    message: () => 'Cannot set new job: a job is already set or being processed'
  },
  [ERR_CODES.INVALID_AUDIO_INPUT]: {
    name: 'INVALID_AUDIO_INPUT',
    message: (message) => `Invalid audio input: ${message}`
  }
}, {
  name,
  version
})

module.exports = {
  ERR_CODES,
  QvacErrorAddonWhisper
}
