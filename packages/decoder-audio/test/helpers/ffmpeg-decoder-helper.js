'use strict'

const path = require('bare-path')
const { FFmpegDecoder } = require('../..')
const { runDecoder: runDecoderBase } = require('./decoder-helper')

async function loadDecoder (params = {}) {
  const config = {
    audioFormat: params.audioFormat || 's16le',
    sampleRate: params.sampleRate || 16000,
    streamIndex: params.streamIndex || 0,
    inputBitrate: params.inputBitrate || 192000
  }

  const decoder = new FFmpegDecoder({ config })
  await decoder.load()

  return decoder
}

async function runDecoder (decoder, audioFilePath, expectation = {}, params = {}) {
  const defaultRawPath = path.join(__dirname, '../../../example/output_ffmpeg.raw')
  const defaultAudioFormat = params.audioFormat || decoder.config?.audioFormat || 's16le'

  return runDecoderBase(decoder, audioFilePath, expectation, { ...params, audioFormat: defaultAudioFormat }, defaultRawPath)
}

module.exports = { loadDecoder, runDecoder }
