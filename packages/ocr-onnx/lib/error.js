'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonOcr extends QvacErrorBase { }

// This library has error code range from 9001 to 10000
const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 9001,
  FAILED_TO_ACTIVATE: 9002,
  FAILED_TO_PAUSE: 9003,
  FAILED_TO_APPEND: 9004,
  FAILED_TO_GET_STATUS: 9005,
  FAILED_TO_DESTROY: 9006,
  INVALID_BMP_OR_INSUFFICIENT_DATA: 9007,
  INVALID_BMP_FILE: 9008,
  INCOMPLETE_BMP_DATA: 9009,
  UNSUPPORTED_BMP_HEADER_SIZE: 9010,
  INVALID_BMP_PIXEL_DATA: 9011,
  MISSING_REQUIRED_PARAMETER: 9012,
  UNSUPPORTED_IMAGE_FORMAT: 9013,
  IMAGE_DECODE_FAILED: 9014,
  UNSUPPORTED_LANGUAGE: 9015,
  FAILED_TO_RUN_JOB: 9016
})

addCodes({
  [ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
    name: 'FAILED_TO_LOAD_WEIGHTS',
    message: (message) => `Failed to load weights, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_ACTIVATE]: {
    name: 'FAILED_TO_ACTIVATE',
    message: (message) => `Failed to activate model, error: ${message}`
  },
  [ERR_CODES.FAILED_TO_PAUSE]: {
    name: 'FAILED_TO_PAUSE',
    message: (message) => `Failed to pause inference, error: ${message}`
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
  [ERR_CODES.INVALID_BMP_OR_INSUFFICIENT_DATA]: {
    name: 'INVALID_BMP_OR_INSUFFICIENT_DATA',
    message: (path) => `Invalid BMP file or insufficient data, file: ${path}`
  },
  [ERR_CODES.INVALID_BMP_FILE]: {
    name: 'INVALID_BMP_FILE',
    message: (path) => `Invalid BMP file, file: ${path}`
  },
  [ERR_CODES.INCOMPLETE_BMP_DATA]: {
    name: 'INCOMPLETE_BMP_DATA',
    message: (path) => `Incomplete BMP data, file: ${path}`
  },
  [ERR_CODES.UNSUPPORTED_BMP_HEADER_SIZE]: {
    name: 'UNSUPPORTED_BMP_HEADER_SIZE',
    message: (path) => `Unsupported BMP header size, file: ${path}`
  },
  [ERR_CODES.INVALID_BMP_PIXEL_DATA]: {
    name: 'INVALID_BMP_PIXEL_DATA',
    message: (path) => `Invalid BMP pixel data, file: ${path}`
  },
  [ERR_CODES.MISSING_REQUIRED_PARAMETER]: {
    name: 'MISSING_REQUIRED_PARAMETER',
    message: (paramName) => `Missing required parameter: ${paramName}`
  },
  [ERR_CODES.UNSUPPORTED_IMAGE_FORMAT]: {
    name: 'UNSUPPORTED_IMAGE_FORMAT',
    message: (path) => `Unsupported image format. Supported formats: BMP, JPEG, PNG. File: ${path}`
  },
  [ERR_CODES.IMAGE_DECODE_FAILED]: {
    name: 'IMAGE_DECODE_FAILED',
    message: (path) => `Failed to decode image, file: ${path}`
  },
  [ERR_CODES.UNSUPPORTED_LANGUAGE]: {
    name: 'UNSUPPORTED_LANGUAGE',
    message: (langList) => `Unsupported language: ${langList}`
  },
  [ERR_CODES.FAILED_TO_RUN_JOB]: {
    name: 'FAILED_TO_RUN_JOB',
    message: (message) => `Failed to run job, error: ${message}`
  }
})

module.exports = {
  ERR_CODES,
  QvacErrorAddonOcr
}
