'use strict'

const { Readable } = require('bare-stream')
const { FFmpegDecoder } = require('@qvac/decoder-audio')
const { QvacErrorTranscriptionUtils, ERR_CODES } = require('./src/utils/errors')
const AUDIO_FORMAT_OPTIONS = [
  'decoded',
  'encoded',
  's16le',
  'f32le',
  'mp3',
  'wav',
  'm4a'
]
const ADDONS_SUPPORTED = ['decoder', 'whisperAddon']

/**
 * Composite addon that chains a decoder and Whisper inference.
 * Users can optionally supply custom instances for decoder and Whisper.
 * The pipeline will adapt based on which components are provided:
 * - Only whisperAddon: Stream directly to Whisper (with optional VAD in whisper config)
 * - Both decoder and whisperAddon: Stream through decoder → Whisper
 */
class TranscriptionPipeline {
  /**
   * @param {Object} addons - Inference arguments
   * @param {Object} addons.whisperAddon - Whisper addon instance (required)
   * @param {Object} [addons.decoder] - Optional FFmpegDecoder instance
   * @param {Object} config - Configuration for defaults
   */
  constructor (addons, config) {
    const { decoder, whisperAddon } = addons
    if (!whisperAddon) {
      throw new QvacErrorTranscriptionUtils(
        ERR_CODES.WHISPER_ADDON_MISSING,
        'whisperAddon argument is required'
      )
    }

    if (Object.keys(addons).some(addon => !ADDONS_SUPPORTED.includes(addon))) {
      throw new QvacErrorTranscriptionUtils(
        ERR_CODES.ADDON_NOT_SUPPORTED,
        `Invalid argument for addons passed, please provide only ${ADDONS_SUPPORTED.join(
          ', '
        )}`
      )
    }

    this.config = config || {}

    if (!this.config.audioFormat) {
      this.config.audioFormat = 'encoded'
    }

    if (!AUDIO_FORMAT_OPTIONS.includes(this.config.audioFormat)) {
      throw new QvacErrorTranscriptionUtils(
        ERR_CODES.WRONG_AUDIO_FORMAT,
        `'audioFormat' config can only be one of: ${AUDIO_FORMAT_OPTIONS.join(
          ', '
        )}`
      )
    }

    if (config?.audioFormat !== 'decoded' || decoder) {
      if (!decoder) {
        this.decoder = new FFmpegDecoder({
          config: {
            audioFormat: config?.audioFormat,
            sampleRate: config?.sampleRate
          }
        })
      } else {
        this.decoder = decoder
      }
    }

    this.whisperAddon = whisperAddon
  }

  /**
   * Load all provided components.
   */
  async load (closeLoader = true, reportProgress = () => {}) {
    const loadPromises = [
      await this.whisperAddon.load(closeLoader, reportProgress)
    ]

    if (this.decoder) {
      loadPromises.push(this.decoder.load())
    }
    await Promise.all(loadPromises)
  }

  /**
   * Unload all provided components.
   */
  async unload () {
    const unloadPromises = [this.whisperAddon.unload()]

    if (this.decoder) {
      unloadPromises.push(this.decoder.unload())
    }

    await Promise.all(unloadPromises)
  }

  /**
   * Run the pipeline on an input audio stream.
   * The pipeline adapts based on which components are provided.
   * @param {Readable} audioStream - Audio stream
   * @returns {QvacResponse} streaming transcription response
   */
  async run (audioStream) {
    let decodedStream = null

    if (this.decoder) {
      decodedStream = new Readable({ read () {} })

      const decRes = await this.decoder.run(audioStream)
      decRes
        .onUpdate(({ outputArray }) => {
          decodedStream.push(Buffer.from(outputArray))
        })
        .onFinish(() => {
          decodedStream.push(null)
        })
    }

    const whisperInputStream = decodedStream || audioStream

    return await this.whisperAddon.run(whisperInputStream)
  }

  /**
   * Download model files for Whisper
   * @param {Object|null} progressReport - Optional progress report instance
   */
  async download (progressReport = null) {
    return this.whisperAddon.download(progressReport)
  }

  /**
   * Delete local model files for all components.
   */
  async delete () {
    return this.whisperAddon.delete()
  }

  /**
   * Pause inference for all components.
   */
  pause () {
    const promises = []
    if (this.decoder?.pause) {
      promises.push(this.decoder.pause())
    }
    if (this.whisperAddon.pause) {
      promises.push(this.whisperAddon.pause())
    }
    return Promise.all(promises)
  }

  /**
   * Unpause (resume) inference for all components.
   */
  unpause () {
    const promises = []
    if (this.decoder?.unpause) {
      promises.push(this.decoder.unpause())
    }
    if (this.whisperAddon.unpause) {
      promises.push(this.whisperAddon.unpause())
    }
    return Promise.all(promises)
  }

  /**
   * Stop inference for all components.
   */
  stop () {
    const promises = []
    if (this.decoder?.stop) {
      promises.push(this.decoder.stop())
    }
    if (this.whisperAddon.stop) {
      promises.push(this.whisperAddon.stop())
    }
    return Promise.all(promises)
  }

  /**
   * Get status of all components.
   * @returns {Object} statuses keyed by component
   */
  status () {
    return this.whisperAddon.status()
  }

  /**
   * Identifies which model API should be used on current environment
   */
  getApiDefinition () {
    return this.whisperAddon.getApiDefinition()
  }
}

module.exports = TranscriptionPipeline
