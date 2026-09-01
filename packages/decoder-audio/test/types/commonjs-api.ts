// Compile-only assertion over the published declarations. Never executed —
// `npm run test:dts` type-checks it against the generated .d.ts files.
import decoderAudio = require('../../index')
import {
  FFmpegDecoder,
  type DecoderOutput,
  type FFmpegDecoderConstructorParams,
  type RuntimeStats
} from '../../index'
import { FORMATS_NEEDING_DECODE, SUPPORTED_AUDIO_FORMATS } from '../../constants'
import { ERR_CODES, QvacErrorDecoderAudio } from '../../utils/error'
import createStreamAccumulator = require('../../utils/createStreamAccumulator')

// Both import styles reach the same constructor.
const namespaceConstructor: typeof FFmpegDecoder = decoderAudio.FFmpegDecoder
const namedConstructor: typeof FFmpegDecoder = FFmpegDecoder

// Constructor accepts the documented config, and the top-level fallbacks.
const params: FFmpegDecoderConstructorParams = {
  config: { audioFormat: 's16le', sampleRate: 16000, streamIndex: 0, inputBitrate: 192000 },
  logger: null
}
const decoder = new FFmpegDecoder(params)
const defaulted = new FFmpegDecoder()
const withFallbacks = new FFmpegDecoder({ audioFormat: 'f32le', streamIndex: 1 })

// Lifecycle returns promises.
const loaded: Promise<void> = decoder.load()
const unloaded: Promise<void> = decoder.unload()

// Public constants resolved by load().
const supportedFormats: number | null = decoder.SUPPORTED_AUDIO_FORMATS.s16le.format
const byteLength: number = decoder.SUPPORTED_AUDIO_FORMATS.f32le.byteLength
const channelLayout: number | null = decoder.OUTPUT_CHANNEL_LAYOUT

// run() yields a QvacResponse whose output chunks carry a Buffer.
declare const audioStream: AsyncIterable<Buffer>
const response = decoder.run(audioStream)
response.onUpdate((output: DecoderOutput) => {
  const bytes: Buffer = output.outputArray
  // Mirrors how @qvac/inference consumes each chunk.
  const view = new Uint8Array(output.outputArray)
  void [bytes, view]
})
const cancelled: Promise<void> = response.cancel()

// runtimeStats() shape.
const stats: RuntimeStats = decoder.runtimeStats()
const codecName: string | null = stats.codecName
const audioFormat: 's16le' | 'f32le' = stats.audioFormat
const decodeTimeMs: number = stats.decodeTimeMs

// The ./constants subpath.
const needsDecode: readonly string[] = FORMATS_NEEDING_DECODE
const supported: readonly string[] = SUPPORTED_AUDIO_FORMATS
const includesMp3: boolean = FORMATS_NEEDING_DECODE.includes('.mp3')

// utils/error ships declarations and the frozen code map.
const errorCode: number = ERR_CODES.BUFFER_SIZE_TOO_SMALL
const decoderError: Error = new QvacErrorDecoderAudio({ code: ERR_CODES.JOB_CANCELLED })

// utils/createStreamAccumulator still exports a bare function, not a namespace object.
const accumulator = createStreamAccumulator({
  onChunk: (chunk: Uint8Array) => {
    void chunk
  },
  onFinish: () => {},
  targetBufferSize: 64000
})
const processed: Promise<void> = accumulator.processData(Buffer.alloc(0))
const finished: Promise<void> = accumulator.finish()

void [
  namespaceConstructor,
  namedConstructor,
  defaulted,
  withFallbacks,
  loaded,
  unloaded,
  supportedFormats,
  byteLength,
  channelLayout,
  cancelled,
  stats,
  codecName,
  audioFormat,
  decodeTimeMs,
  needsDecode,
  supported,
  includesMp3,
  errorCode,
  decoderError,
  processed,
  finished
]
