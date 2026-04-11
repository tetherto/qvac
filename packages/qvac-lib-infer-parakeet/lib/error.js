'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonParakeet extends QvacErrorBase { }

const { name, version } = require('../package.json')

// This library has error code range from 24,001 to 25,000
const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 24001,
  FAILED_TO_CANCEL: 24002,
  FAILED_TO_APPEND: 24003,
  FAILED_TO_GET_STATUS: 24004,
  FAILED_TO_DESTROY: 24005,
  FAILED_TO_ACTIVATE: 24006,
  FAILED_TO_RESET: 24007,
  FAILED_TO_PAUSE: 24008,
  MODEL_NOT_FOUND: 24009,
  INVALID_AUDIO_FORMAT: 24010,
  PREPROCESSOR_NOT_FOUND: 24011,
  VOCAB_NOT_FOUND: 24012,
  ENCODER_NOT_FOUND: 24013,
  DECODER_NOT_FOUND: 24014,
  INVALID_CONFIG: 24015,
  JOB_ALREADY_RUNNING: 24016,
  BUFFER_LIMIT_EXCEEDED: 24017,
  INSTANCE_DESTROYED: 24018,
  JOB_CANCELLED: 24019
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
    message: (message) => `Failed to append audio data to processing queue, error: ${message}`
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
  [ERR_CODES.MODEL_NOT_FOUND]: {
    name: 'MODEL_NOT_FOUND',
    message: (path) => `Model not found at path: ${path}`
  },
  [ERR_CODES.INVALID_AUDIO_FORMAT]: {
    name: 'INVALID_AUDIO_FORMAT',
    message: (format) => `Invalid audio format: ${format}. Expected 16kHz mono audio.`
  },
  [ERR_CODES.PREPROCESSOR_NOT_FOUND]: {
    name: 'PREPROCESSOR_NOT_FOUND',
    message: () => 'Preprocessor model (preprocessor.onnx) not found. Required for accurate transcription.'
  },
  [ERR_CODES.VOCAB_NOT_FOUND]: {
    name: 'VOCAB_NOT_FOUND',
    message: () => 'Vocabulary file (vocab.txt) not found.'
  },
  [ERR_CODES.ENCODER_NOT_FOUND]: {
    name: 'ENCODER_NOT_FOUND',
    message: () => 'Encoder model (encoder-model.onnx) not found.'
  },
  [ERR_CODES.DECODER_NOT_FOUND]: {
    name: 'DECODER_NOT_FOUND',
    message: () => 'Decoder model (decoder_joint-model.onnx) not found.'
  },
  [ERR_CODES.INVALID_CONFIG]: {
    name: 'INVALID_CONFIG',
    message: (message) => `Invalid configuration: ${message}`
  },
  [ERR_CODES.JOB_ALREADY_RUNNING]: {
    name: 'JOB_ALREADY_RUNNING',
    message: () => 'Cannot set new job: a job is already set or being processed'
  },
  [ERR_CODES.BUFFER_LIMIT_EXCEEDED]: {
    name: 'BUFFER_LIMIT_EXCEEDED',
    message: (message) => `Audio buffer size limit exceeded: ${message}`
  },
  [ERR_CODES.INSTANCE_DESTROYED]: {
    name: 'INSTANCE_DESTROYED',
    message: () => 'Cannot load: instance has been destroyed'
  },
  [ERR_CODES.JOB_CANCELLED]: {
    name: 'JOB_CANCELLED',
    message: () => 'Job cancelled'
  }
}, {
  name,
  version
})

const END_OF_INPUT = 'end of job'

module.exports = {
  ERR_CODES,
  QvacErrorAddonParakeet,
  END_OF_INPUT
}
