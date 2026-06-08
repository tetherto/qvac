import { runFfmpeg, FfmpegFailedError, FfmpegTimeoutError, type FfmpegRunOptions } from './ffmpeg.js'

export type AudioEncodeOptions = FfmpegRunOptions
export { FfmpegFailedError as AudioEncodeFailedError, FfmpegTimeoutError as AudioEncodeTimeoutError }

/** Encoded (transcoder-backed) speech formats, distinct from native wav/pcm. */
export type EncodedSpeechFormat = 'mp3' | 'opus' | 'aac' | 'flac'

export const ENCODED_SPEECH_FORMATS: readonly EncodedSpeechFormat[] = ['mp3', 'opus', 'aac', 'flac']

// Per-format ffmpeg encode arguments. Input is the WAV buffer the route already
// builds (RIFF/PCM s16le mono) on stdin (`pipe:0`); output container on stdout
// (`pipe:1`). Container choices that aren't the codec's obvious default:
//   opus → Ogg container (`-f ogg`), the streamable Opus container browsers and
//     Open WebUI expect; raw `.opus`/`-f opus` is not seekable over a pipe.
//   aac  → ADTS container (`-f adts`), the framed elementary stream that plays
//     standalone; bare `-f aac` produces a raw stream most players reject.
const ENCODE_ARGS: Record<EncodedSpeechFormat, readonly string[]> = {
  mp3: ['-c:a', 'libmp3lame', '-f', 'mp3'],
  opus: ['-c:a', 'libopus', '-f', 'ogg'],
  aac: ['-c:a', 'aac', '-f', 'adts'],
  flac: ['-c:a', 'flac', '-f', 'flac']
}

/** Builds the full ffmpeg arg list for encoding WAV → `format`. Exported for unit tests. */
export function speechEncodeArgs (format: EncodedSpeechFormat): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', 'pipe:0',
    ...ENCODE_ARGS[format],
    'pipe:1'
  ]
}

/** Encode the route's WAV buffer into `format` via the system ffmpeg binary. */
export async function transcodeWav (
  input: Buffer,
  format: EncodedSpeechFormat,
  opts: AudioEncodeOptions = {}
): Promise<Buffer> {
  return await runFfmpeg(speechEncodeArgs(format), input, opts)
}

export { probeFfmpegAvailable } from './ffmpeg.js'
