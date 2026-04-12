'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

// Define error codes specific to this library - range 3001-4000
const ERR_CODES = Object.freeze({
  OPTS_INVALID: 3001,
  PATH_INVALID: 3002,
  FILE_NOT_FOUND: 3003,
  DIR_NOT_FOUND: 3004,
  ACCESS_DENIED: 3005,
  READ_ERROR: 3006
})

// Register error definitions
addCodes({
  [ERR_CODES.OPTS_INVALID]: {
    name: 'OPTS_INVALID',
    message: 'Invalid options: dirPath is required'
  },
  [ERR_CODES.PATH_INVALID]: {
    name: 'PATH_INVALID',
    message: (path) => `Invalid path: ${path}`
  },
  [ERR_CODES.FILE_NOT_FOUND]: {
    name: 'FILE_NOT_FOUND',
    message: (path) => `File not found: ${path}`
  },
  [ERR_CODES.DIR_NOT_FOUND]: {
    name: 'DIR_NOT_FOUND',
    message: (path) => `Directory not found: ${path}`
  },
  [ERR_CODES.ACCESS_DENIED]: {
    name: 'ACCESS_DENIED',
    message: (path) => `Access denied to: ${path}`
  },
  [ERR_CODES.READ_ERROR]: {
    name: 'READ_ERROR',
    message: (path) => `Error reading file: ${path}`
  }
})

// Create a specialized error class for the filesystem library
class QvacErrorFilesystem extends QvacErrorBase {}

module.exports = {
  QvacErrorFilesystem,
  ERR_CODES
}
