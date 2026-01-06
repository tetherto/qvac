'use strict'

/**
 * Audio formats that require decoding before processing
 */
const FORMATS_NEEDING_DECODE = [
  '.mp3',
  '.m4a',
  '.ogg',
  '.flac',
  '.aac',
  '.wav'
]

/**
 * All supported audio formats (including raw)
 */
const SUPPORTED_AUDIO_FORMATS = [
  '.mp3',
  '.m4a',
  '.ogg',
  '.wav',
  '.flac',
  '.aac',
  '.raw'
]

module.exports = {
  FORMATS_NEEDING_DECODE,
  SUPPORTED_AUDIO_FORMATS
}
