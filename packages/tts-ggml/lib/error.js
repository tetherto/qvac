'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')

class QvacErrorAddonTTSGgml extends QvacErrorBase { }

const { name, version } = require('../package.json')

// This library has error code range from 13001 to 14000.
// (7001-7999 is owned by @qvac/tts-onnx; a separate range keeps
// the global addCodes() registry conflict-free when both packages
// coexist in the same Bare process.)
//
// Reserved-but-not-thrown today (kept for stable code numbering and
// covered by tts.error.test.js so accidental renumbering breaks loudly):
//   - FAILED_TO_PAUSE / FAILED_TO_STOP — pause/stop intentionally not
//     implemented in addon-cpp 1.x; cancel() is the only path.
//   - JOB_ALREADY_RUNNING — JobRunner already serialises on the C++ side
//     and rejects via runJob() returning false; no JS code path throws
//     this today.  Will be wired in once JS surfaces busy state.
const ERR_CODES = Object.freeze({
  FAILED_TO_ACTIVATE: 13001,
  FAILED_TO_APPEND: 13002,
  FAILED_TO_GET_STATUS: 13003,
  FAILED_TO_PAUSE: 13004,
  FAILED_TO_CANCEL: 13005,
  FAILED_TO_DESTROY: 13006,
  FAILED_TO_UNLOAD: 13007,
  FAILED_TO_LOAD: 13008,
  FAILED_TO_RELOAD: 13009,
  FAILED_TO_STOP: 13010,
  JOB_ALREADY_RUNNING: 13011
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
  QvacErrorAddonTTSGgml
}
