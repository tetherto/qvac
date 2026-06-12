'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')
const { name, version } = require('../package.json')

// Define error codes specific to this library - range 3001-4000
const ERR_CODES = Object.freeze({
  NOT_IMPLEMENTED: 3101,
  LOAD_NOT_IMPLEMENTED: 3102,
  ADDON_METHOD_NOT_IMPLEMENTED: 3103,
  LOADER_NOT_FOUND: 3104,
  ADDON_INTERFACE_REQUIRED: 3105,
  ADDON_NOT_INITIALIZED: 3106,

  // WeightsProvider
  DOWNLOAD_FAILED: 4001
})

// Register error definitions
addCodes({
  [ERR_CODES.NOT_IMPLEMENTED]: {
    name: 'NOT_IMPLEMENTED',
    message: (funcName) => `${funcName} function is not implemented`
  },
  [ERR_CODES.LOAD_NOT_IMPLEMENTED]:
  {
    name: 'LOAD_NOT_IMPLEMENTED',
    message:
      (funcName) => `${funcName} function is not implemented by the loader`
  },
  [ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED]:
  {
    name: 'ADDON_METHOD_NOT_IMPLEMENTED',
    message:
      (methodName) => `addon does not implement method ${methodName}`
  },
  [ERR_CODES.LOADER_NOT_FOUND]:
  {
    name: 'LOADER_NOT_FOUND',
    message: 'Loader not found'
  },
  [ERR_CODES.ADDON_INTERFACE_REQUIRED]:
  {
    name: 'ADDON_INTERFACE_REQUIRED',
    message: 'AddonInterface is required for this operation'
  },
  [ERR_CODES.ADDON_NOT_INITIALIZED]:
  {
    name: 'ADDON_NOT_INITIALIZED',
    message: 'Addon has not been initialized'
  },
  [ERR_CODES.DOWNLOAD_FAILED]:
  {
    name: 'DOWNLOAD_FAILED',
    message: (error) => `Error while downloading file with message: ${error.message}`
  }
}, {
  name,
  version
})

// Create a specialized error class for the inference base library
class QvacInferenceBaseError extends QvacErrorBase { }

module.exports = {
  QvacInferenceBaseError,
  ERR_CODES
}
