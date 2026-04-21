'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonBCI extends QvacErrorBase { }

const { name, version } = require('../package.json')

// This library has error code range from 26001 to 27000.
// Ranges used elsewhere in the @qvac/error registry:
//   6001-6018  @qvac/transcription-whispercpp
//   7001-7011  @qvac/tts-onnx
//   8001-8008  @qvac/translation-nmtcpp
//   24001+     @qvac/transcription-parakeet
const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 26001,
  FAILED_TO_CANCEL: 26002,
  FAILED_TO_APPEND: 26003,
  FAILED_TO_GET_STATUS: 26004,
  FAILED_TO_DESTROY: 26005,
  FAILED_TO_ACTIVATE: 26006,
  FAILED_TO_RESET: 26007,
  FAILED_TO_PAUSE: 26008,
  INVALID_NEURAL_INPUT: 26009,
  JOB_ALREADY_RUNNING: 26010,
  MODEL_NOT_LOADED: 26011,
  MODEL_FILE_NOT_FOUND: 26012,
  BUFFER_LIMIT_EXCEEDED: 26013,
  FAILED_TO_START_JOB: 26014,
  INVALID_CONFIG: 26015,
  EMBEDDER_WEIGHTS_INVALID: 26016
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
  },
  [ERR_CODES.MODEL_FILE_NOT_FOUND]: {
    name: 'MODEL_FILE_NOT_FOUND',
    message: (modelPath) => `Model file not found at: ${modelPath}`
  },
  [ERR_CODES.BUFFER_LIMIT_EXCEEDED]: {
    name: 'BUFFER_LIMIT_EXCEEDED',
    message: (limit) => `Neural signal buffer exceeded limit of ${limit}`
  },
  [ERR_CODES.FAILED_TO_START_JOB]: {
    name: 'FAILED_TO_START_JOB',
    message: (message) => `Failed to start inference job, error: ${message}`
  },
  [ERR_CODES.INVALID_CONFIG]: {
    name: 'INVALID_CONFIG',
    message: (message) => `Invalid BCI configuration: ${message}`
  },
  [ERR_CODES.EMBEDDER_WEIGHTS_INVALID]: {
    name: 'EMBEDDER_WEIGHTS_INVALID',
    message: (message) => `BCI embedder weights are invalid: ${message}`
  }
}, {
  name,
  version
})

module.exports = {
  ERR_CODES,
  QvacErrorAddonBCI
}
