import fs from 'bare-fs'
import {
  AUDIOGEN_INPUT_CHANNELS,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  type AudioGenAudioInput
} from '@/schemas/audio-gen'
import { decodeAudioToStream, needsDecoding } from '@/server/utils/audio/decoder'
import { AudioFileNotFoundError, InvalidAudioInputError } from '@/utils/errors-server'

const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT
const STEREO_FRAME_BYTES = FLOAT32_BYTES * AUDIOGEN_INPUT_CHANNELS

export type AudioGenAudioInputName = 'referenceAudio' | 'sourceAudio'

/**
 * Resolve a reference/source audio input into the interleaved stereo 48 kHz
 * Float32 PCM the ACE-Step engine consumes.
 *
 * - `base64` inputs (client `Buffer`/`Uint8Array`) must already be raw
 *   interleaved stereo 48 kHz Float32 LE PCM; they are copied into an aligned
 *   `Float32Array` without conversion.
 * - `filePath` inputs with a decodable extension (`.wav`, `.mp3`, `.m4a`,
 *   `.ogg`, `.flac`, `.aac`) are decoded through the SDK's FFmpeg decoder to
 *   48 kHz mono float PCM and duplicated onto both channels. Any other
 *   extension is read as raw interleaved stereo 48 kHz Float32 LE PCM.
 */
export async function resolveAudioGenPcm(
  input: AudioGenAudioInput,
  name: AudioGenAudioInputName
): Promise<Float32Array> {
  switch (input.type) {
    case 'base64':
      return toStereoFloat32(Buffer.from(input.value, 'base64'), name)
    case 'filePath': {
      const filePath = input.value
      try {
        fs.accessSync(filePath)
      } catch (error: unknown) {
        throw new AudioFileNotFoundError(filePath, error)
      }
      if (!needsDecoding(filePath)) {
        return toStereoFloat32(readBytes(filePath), name)
      }
      return monoToStereo(await decodeMonoFloat32(filePath, name), name)
    }
    default:
      throw new InvalidAudioInputError(`${name} must be a file path or raw PCM bytes`)
  }
}

function readBytes(filePath: string) {
  const contents = fs.readFileSync(filePath)
  return typeof contents === 'string' ? Buffer.from(contents) : contents
}

async function decodeMonoFloat32(filePath: string, name: AudioGenAudioInputName) {
  const chunks: Buffer[] = []
  try {
    const stream = await decodeAudioToStream(filePath, 'f32le', AUDIOGEN_INPUT_SAMPLE_RATE)
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    }
  } catch (error) {
    throw new InvalidAudioInputError(`${name} could not be decoded from ${filePath}`, error)
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.byteLength === 0 || bytes.byteLength % FLOAT32_BYTES !== 0) {
    throw new InvalidAudioInputError(`${name} decoded to no usable audio from ${filePath}`)
  }
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

function monoToStereo(mono: Float32Array, name: AudioGenAudioInputName) {
  if (mono.length === 0) {
    throw new InvalidAudioInputError(`${name} decoded to no usable audio`)
  }
  const stereo = new Float32Array(mono.length * AUDIOGEN_INPUT_CHANNELS)
  for (let frame = 0; frame < mono.length; frame++) {
    const sample = mono[frame]!
    stereo[frame * AUDIOGEN_INPUT_CHANNELS] = sample
    stereo[frame * AUDIOGEN_INPUT_CHANNELS + 1] = sample
  }
  return stereo
}

function toStereoFloat32(bytes: Uint8Array, name: AudioGenAudioInputName) {
  if (bytes.byteLength === 0 || bytes.byteLength % STEREO_FRAME_BYTES !== 0) {
    throw new InvalidAudioInputError(
      `${name} must be non-empty interleaved stereo ${AUDIOGEN_INPUT_SAMPLE_RATE} Hz Float32 PCM ` +
        `(byte length a multiple of ${STEREO_FRAME_BYTES}, got ${bytes.byteLength})`
    )
  }
  // Copy into a fresh, 4-byte aligned buffer: pooled Buffers can sit at an
  // arbitrary byteOffset, which a Float32Array view would reject.
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}
