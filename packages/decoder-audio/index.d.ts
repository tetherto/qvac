import { QvacResponse } from '@qvac/infer-base'

interface AudioFormatConfig {
  format: number | null
  byteLength: number
}

interface SupportedAudioFormats {
  s16le: AudioFormatConfig
  f32le: AudioFormatConfig
}

interface FFmpegDecoderConfig {
  streamIndex?: number
  inputBitrate?: number
  audioFormat?: 's16le' | 'f32le'
  sampleRate?: number
}

interface FFmpegDecoderConstructorParams {
  config?: FFmpegDecoderConfig
  logger?: any
  streamIndex?: number
  inputBitrate?: number
  audioFormat?: 's16le' | 'f32le'
}

export interface DecoderOutput {
  outputArray: ArrayBuffer
}

interface RuntimeStats {
  decodeTimeMs: number
  inputBytes: number
  outputBytes: number
  samplesDecoded: number
  codecName: string | null
  inputSampleRate: number
  outputSampleRate: number
  audioFormat: 's16le' | 'f32le'
}

declare class FFmpegDecoder {
  SUPPORTED_AUDIO_FORMATS: SupportedAudioFormats
  OUTPUT_CHANNEL_LAYOUT: number | null

  constructor(params?: FFmpegDecoderConstructorParams)

  load(): Promise<void>
  unload(): Promise<void>
  run(audioStream: AsyncIterable<Buffer>): QvacResponse<DecoderOutput>

  runtimeStats(): RuntimeStats
}

export { FFmpegDecoder, RuntimeStats, DecoderOutput }
