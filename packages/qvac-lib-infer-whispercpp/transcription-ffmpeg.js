'use strict'

const TranscriptionPipeline = require('@qvac/util-transcription')
const TranscriptionWhispercpp = require('./index')
const { FFmpegDecoder } = require('@qvac/decoder-audio')

/**
 * TranscriptionFfmpegAddon - Combines Whisper transcription with FFmpeg audio decoding
 *
 * This class provides a complete pipeline for transcribing audio files by:
 * 1. Decoding audio using FFmpeg decoder
 * 2. Transcribing the decoded audio using Whisper
 */
class TranscriptionFfmpegAddon extends TranscriptionPipeline {
  constructor ({ loader, params, logger, ...args }, config = {}) {
    const whisperAddon = new TranscriptionWhispercpp(
      {
        loader,
        params,
        logger,
        ...args
      },
      { ...config }
    )

    // Create FFmpeg decoder instance
    // audio_format can be at top level or inside whisperConfig
    const decoder = new FFmpegDecoder({
      config: { ...params.decoder, audioFormat: config?.audio_format || config?.whisperConfig?.audio_format },
      logger
    })

    super({ whisperAddon, decoder }, params.decoder)
  }
}

module.exports = TranscriptionFfmpegAddon
