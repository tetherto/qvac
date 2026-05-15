'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')
const { name, version } = require('../package.json')

class QvacErrorAddonVla extends QvacErrorBase { }

// This library has error code range from 30001 to 31000
const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 30001,
  FAILED_TO_DESTROY: 30002,
  MODEL_NOT_FOUND: 30003,
  INVALID_CONFIG: 30004,
  MISSING_REQUIRED_PARAMETER: 30005,
  INVALID_INPUT: 30006,
  JOB_ALREADY_RUNNING: 30007,
  INSTANCE_NOT_INITIALIZED: 30008,
  MODEL_UNLOADED: 30009,
  INFERENCE_FAILED: 30010
})

addCodes(
  {
    [ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
      name: 'FAILED_TO_LOAD_WEIGHTS',
      message: message => `Failed to load weights, error: ${message}`
    },
    [ERR_CODES.FAILED_TO_DESTROY]: {
      name: 'FAILED_TO_DESTROY',
      message: message => `Failed to destroy instance, error: ${message}`
    },
    [ERR_CODES.MODEL_NOT_FOUND]: {
      name: 'MODEL_NOT_FOUND',
      message: path => `SmolVLA GGUF not found: ${path}`
    },
    [ERR_CODES.INVALID_CONFIG]: {
      name: 'INVALID_CONFIG',
      message: message => `Invalid configuration: ${message}`
    },
    [ERR_CODES.MISSING_REQUIRED_PARAMETER]: {
      name: 'MISSING_REQUIRED_PARAMETER',
      message: paramName => `Missing required parameter: ${paramName}`
    },
    [ERR_CODES.INVALID_INPUT]: {
      name: 'INVALID_INPUT',
      message: message => `Invalid input: ${message}`
    },
    [ERR_CODES.JOB_ALREADY_RUNNING]: {
      name: 'JOB_ALREADY_RUNNING',
      message: () => 'Cannot set new job: a job is already set or being processed'
    },
    [ERR_CODES.INSTANCE_NOT_INITIALIZED]: {
      name: 'INSTANCE_NOT_INITIALIZED',
      message: () => 'Addon not initialized. Call load() first.'
    },
    [ERR_CODES.MODEL_UNLOADED]: {
      name: 'MODEL_UNLOADED',
      message: () => 'Model was unloaded'
    },
    [ERR_CODES.INFERENCE_FAILED]: {
      name: 'INFERENCE_FAILED',
      message: message => `Inference failed: ${message}`
    }
  },
  {
    name,
    version
  }
)

module.exports = {
  ERR_CODES,
  QvacErrorAddonVla
}
