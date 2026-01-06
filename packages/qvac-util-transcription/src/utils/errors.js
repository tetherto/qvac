'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')
const { name, version } = require('../../package.json')

class QvacErrorTranscriptionUtils extends QvacErrorBase {}

const ERR_CODES = Object.freeze({
  WRONG_AUDIO_FORMAT: 8201,
  ADDON_NOT_SUPPORTED: 8202,
  WHISPER_ADDON_MISSING: 8203
})

addCodes({
  [ERR_CODES.WRONG_AUDIO_FORMAT]: {
    name: 'WRONG_AUDIO_FORMAT',
    message: message => `Wrong config for audioFormat, error: ${message}`
  },
  [ERR_CODES.ADDON_NOT_SUPPORTED]: {
    name: 'ADDON_NOT_SUPPORTED',
    message: message => `Invalid argument for addons passed, error: ${message}`
  },
  [ERR_CODES.WHISPER_ADDON_MISSING]: {
    name: 'WHISPER_ADDON_MISSING',
    message: message =>
      `Argument for 'whisperAddon' is missing, error: ${message}`
  }
}, {
  name,
  version
})

module.exports = {
  ERR_CODES,
  QvacErrorTranscriptionUtils
}
