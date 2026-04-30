'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

// Define error codes specific to this library - range 1001-2000
const ERR_CODES = Object.freeze({
  KEY_OR_DRIVE_REQUIRED: 1001,
  KEY_INVALID: 1002,
  FILE_NOT_FOUND: 1003,
  CONNECTION_FAILED: 1004,
  DRIVE_NOT_READY: 1005,
  DOWNLOAD_FAILED: 1006
})

// Register error definitions
addCodes({
  [ERR_CODES.KEY_OR_DRIVE_REQUIRED]: {
    name: 'KEY_OR_DRIVE_REQUIRED',
    message: 'Hyperdrive key or drive is required'
  },
  [ERR_CODES.KEY_INVALID]: {
    name: 'KEY_INVALID',
    message: (details) => `Invalid Hyperdrive key${details ? ': ' + details : ''}`
  },
  [ERR_CODES.FILE_NOT_FOUND]: {
    name: 'FILE_NOT_FOUND',
    message: (path) => `File not found: ${path}`
  },
  [ERR_CODES.CONNECTION_FAILED]: {
    name: 'CONNECTION_FAILED',
    message: 'Failed to connect to Hyperdrive peers'
  },
  [ERR_CODES.DRIVE_NOT_READY]: {
    name: 'DRIVE_NOT_READY',
    message: 'Hyperdrive is not ready. Call ready() first'
  },
  [ERR_CODES.DOWNLOAD_FAILED]: {
    name: 'DOWNLOAD_FAILED',
    message: (path) => `Failed to download file: ${path}`
  }
})

// Create a specialized error class for the hyperdrive library
class QvacErrorHyperdrive extends QvacErrorBase {}

module.exports = {
  QvacErrorHyperdrive,
  ERR_CODES
}
