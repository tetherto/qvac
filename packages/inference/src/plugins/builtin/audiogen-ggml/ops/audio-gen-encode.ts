import { AudioGen } from '@qvac/audiogen-ggml'
import type { AudioGenOutputFormat, AudioGenStreamResponse } from '@/schemas/audio-gen'
import { AudioEncodeFailedError } from '@/errors/index'

// A hundredth of a second of stereo silence at 48 kHz: enough for every
// encoder to open, emit a frame and close its container.
const PROBE_SAMPLE_RATE = 48000
const PROBE_CHANNELS = 2
const PROBE_FRAMES = 480

export interface PcmLayout {
  sampleRate: number
  channels: number
}

function encode(pcm: Uint8Array, format: AudioGenOutputFormat, layout: PcmLayout) {
  try {
    return AudioGen.encode(pcm, format, layout)
  } catch (error) {
    throw new AudioEncodeFailedError(
      format,
      error instanceof Error ? error.message : String(error),
      error
    )
  }
}

/**
 * Proves the host can encode `format` before a generation is admitted: the
 * FFmpeg build is the addon's, and a missing encoder would otherwise only
 * surface after the run had finished. `wav` is written in JS and needs no
 * probe.
 */
export function assertOutputFormatAvailable(format: AudioGenOutputFormat): void {
  if (format === 'wav') return
  encode(new Uint8Array(PROBE_FRAMES * PROBE_CHANNELS * Int16Array.BYTES_PER_ELEMENT), format, {
    sampleRate: PROBE_SAMPLE_RATE,
    channels: PROBE_CHANNELS
  })
}

/** Encodes a run's interleaved Int16 PCM into the frame field that carries it. */
export function encodeRunAudio(
  chunks: readonly Uint8Array[],
  format: AudioGenOutputFormat,
  layout: PcmLayout
): NonNullable<AudioGenStreamResponse['encoded']> {
  const pcm = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    pcm.set(chunk, offset)
    offset += chunk.byteLength
  }
  const encoded = encode(pcm, format, layout)
  return {
    data: Buffer.from(
      encoded.data.buffer,
      encoded.data.byteOffset,
      encoded.data.byteLength
    ).toString('base64'),
    format,
    mimeType: encoded.mimeType,
    extension: encoded.extension
  }
}
