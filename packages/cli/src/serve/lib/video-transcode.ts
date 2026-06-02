import { runFfmpeg, FfmpegFailedError, FfmpegTimeoutError, type FfmpegRunOptions } from './ffmpeg.js'

export type TranscodeOptions = FfmpegRunOptions
export { FfmpegFailedError as TranscodeFailedError, FfmpegTimeoutError as TranscodeTimeoutError }

// Two ffmpeg flags here are non-default for piped MP4 output and worth
// surfacing:
//   -vf scale=in_range=full:out_range=tv,format=yuv420p — MJPG sources emit
//     full-range yuvj420p (deprecated); without explicit range conversion the
//     swscaler emits the "make sure you did set range correctly" warning and
//     leaves the H.264 stream's range tag ambiguous, which some players
//     misrender. Combined with `-color_range tv` below, this produces a
//     correctly-tagged TV-range stream.
//   -movflags +frag_keyframe+empty_moov — fragmented MP4 (moov atom split
//     across the head and per-fragment moof boxes). The legacy `+faststart`
//     flag requires a seekable output and fails with `pipe:1`.
const TRANSCODE_ARGS: readonly string[] = [
  '-hide_banner', '-nostdin', '-loglevel', 'error',
  '-i', 'pipe:0',
  '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'fast',
  '-color_range', 'tv',
  '-movflags', '+frag_keyframe+empty_moov',
  '-f', 'mp4', 'pipe:1'
]

/** Transcode the SDK's native MJPG-AVI bytes into a streamable H.264 MP4. */
export async function transcodeAviToMp4 (input: Buffer, opts: TranscodeOptions = {}): Promise<Buffer> {
  return await runFfmpeg([...TRANSCODE_ARGS], input, opts)
}

export { probeFfmpegAvailable } from './ffmpeg.js'
