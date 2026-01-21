import BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
import QvacResponse from '@qvac/response'

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
  [key: string]: any
}

interface DecoderStatus {
  loaded: boolean
  active: boolean
  paused: boolean
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

declare class FFmpegDecoder extends BaseInference {
  SUPPORTED_AUDIO_FORMATS: SupportedAudioFormats
  OUTPUT_CHANNEL_LAYOUT: number | null

  constructor(params: FFmpegDecoderConstructorParams)

  load(): Promise<void>
  unload(): Promise<void>
  run(audioStream: AsyncIterable<Buffer>): Promise<QvacResponse<DecoderOutput>>
  pause(): Promise<void>
  unpause(): Promise<void>
  stop(): Promise<void>
  status(): DecoderStatus
  
  runtimeStats(): RuntimeStats
}

export { FFmpegDecoder, RuntimeStats, DecoderOutput }
