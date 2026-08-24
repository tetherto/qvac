import fs from 'bare-fs'
import {
  AUDIOGEN_INPUT_CHANNELS,
  AUDIOGEN_INPUT_MAX_SECONDS,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  type AudioGenAudioInput
} from '@/schemas/audio-gen'
import { decodeAudioToStream, needsDecoding } from '@/utils/audio/decoder'
import { AudioFileNotFoundError, InvalidAudioInputError } from '@/errors/index'

const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT
const STEREO_FRAME_BYTES = FLOAT32_BYTES * AUDIOGEN_INPUT_CHANNELS
/** Upper bound for raw stereo input bytes (base64 payloads and raw PCM files). */
const MAX_STEREO_BYTES =
  AUDIOGEN_INPUT_MAX_SECONDS * AUDIOGEN_INPUT_SAMPLE_RATE * STEREO_FRAME_BYTES
/** Upper bound for the mono float stream the FFmpeg decoder may emit. */
const MAX_DECODED_MONO_BYTES =
  AUDIOGEN_INPUT_MAX_SECONDS * AUDIOGEN_INPUT_SAMPLE_RATE * FLOAT32_BYTES

export type AudioGenAudioInputName = 'referenceAudio' | 'sourceAudio'

/**
 * Resolve a reference/source audio input into the interleaved stereo 48 kHz
 * Float32 PCM the ACE-Step engine consumes.
 *
 * - `base64` inputs (client `Buffer`/`Uint8Array`) must already be raw
 *   interleaved stereo 48 kHz Float32 LE PCM; they are handed over as-is
 *   (a copy is made only when the bytes are not 4-byte aligned).
 * - `filePath` inputs with a decodable extension (`.wav`, `.mp3`, `.m4a`,
 *   `.ogg`, `.flac`, `.aac`) are decoded through the SDK's FFmpeg decoder to
 *   48 kHz mono float PCM and duplicated onto both channels. Any other
 *   extension is streamed in as raw interleaved stereo 48 kHz Float32 LE PCM.
 *
 * Every path is bounded by `AUDIOGEN_INPUT_MAX_SECONDS` and rejects
 * non-finite samples, so malformed or oversized input fails with
 * `InvalidAudioInputError` before the engine is invoked.
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
      if (!needsDecoding(filePath)) {
        return toStereoFloat32(await readRawPcmFile(filePath, name), name)
      }
      await assertDecodableFileSize(filePath, name)
      return monoToStereo(await decodeMonoFloat32(filePath, name), name)
    }
    default:
      throw new InvalidAudioInputError(`${name} must be a file path or raw PCM bytes`)
  }
}

async function statInput(filePath: string) {
  try {
    return await fs.promises.stat(filePath)
  } catch (error: unknown) {
    throw new AudioFileNotFoundError(filePath, error)
  }
}

/**
 * The FFmpeg decoder buffers the whole input file before emitting PCM, so the
 * file itself is bounded up front: no encoded container for a clip within
 * `AUDIOGEN_INPUT_MAX_SECONDS` exceeds the size of that clip as raw stereo
 * Float32 PCM.
 */
async function assertDecodableFileSize(filePath: string, name: AudioGenAudioInputName) {
  const stats = await statInput(filePath)
  if (stats.size <= MAX_STEREO_BYTES) return
  throw new InvalidAudioInputError(
    `${name} (${filePath}) is ${Math.round(stats.size / 1_000_000)} MB; ` +
      `files over ${Math.round(MAX_STEREO_BYTES / 1_000_000)} MB cannot fit the ` +
      `${AUDIOGEN_INPUT_MAX_SECONDS} s limit and are rejected before decoding`
  )
}

/** Stream a raw PCM file into memory without blocking the event loop, capped by size. */
async function readRawPcmFile(filePath: string, name: AudioGenAudioInputName) {
  const stats = await statInput(filePath)
  assertWithinLimit(stats.size, MAX_STEREO_BYTES, STEREO_FRAME_BYTES, name, filePath)

  const chunks: Uint8Array[] = []
  let total = 0
  const stream = fs.createReadStream(filePath) as unknown as AsyncIterable<Uint8Array>
  for await (const chunk of stream) {
    total += chunk.byteLength
    assertWithinLimit(total, MAX_STEREO_BYTES, STEREO_FRAME_BYTES, name, filePath)
    chunks.push(chunk)
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks as Buffer[], total)
}

async function decodeMonoFloat32(filePath: string, name: AudioGenAudioInputName) {
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    const stream = await decodeAudioToStream(filePath, 'f32le', {
      sampleRate: AUDIOGEN_INPUT_SAMPLE_RATE
    })
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > MAX_DECODED_MONO_BYTES) {
        ;(stream as unknown as { destroy(): void }).destroy()
        assertWithinLimit(total, MAX_DECODED_MONO_BYTES, FLOAT32_BYTES, name, filePath)
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof InvalidAudioInputError) throw error
    throw new InvalidAudioInputError(`${name} could not be decoded from ${filePath}`, error)
  }
  if (total === 0 || total % FLOAT32_BYTES !== 0) {
    throw new InvalidAudioInputError(`${name} decoded to no usable audio from ${filePath}`)
  }
  return asFloat32(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks as Buffer[], total))
}

function monoToStereo(mono: Float32Array, name: AudioGenAudioInputName) {
  if (mono.length === 0) {
    throw new InvalidAudioInputError(`${name} decoded to no usable audio`)
  }
  const stereo = new Float32Array(mono.length * AUDIOGEN_INPUT_CHANNELS)
  for (let frame = 0; frame < mono.length; frame++) {
    const sample = mono[frame]!
    if (!Number.isFinite(sample)) throw nonFiniteError(name)
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
  assertWithinLimit(bytes.byteLength, MAX_STEREO_BYTES, STEREO_FRAME_BYTES, name)
  const pcm = asFloat32(bytes)
  for (let index = 0; index < pcm.length; index++) {
    if (!Number.isFinite(pcm[index]!)) throw nonFiniteError(name)
  }
  return pcm
}

/**
 * View the bytes as Float32 without copying when they are 4-byte aligned
 * (fresh Buffers from base64/file reads and `Buffer.concat` are); only a
 * misaligned pooled slice needs to be copied out.
 */
function asFloat32(bytes: Uint8Array) {
  if (bytes.byteOffset % FLOAT32_BYTES === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / FLOAT32_BYTES)
  }
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

function assertWithinLimit(
  bytes: number,
  limit: number,
  frameBytes: number,
  name: AudioGenAudioInputName,
  filePath?: string
) {
  if (bytes <= limit) return
  const seconds = Math.round(bytes / frameBytes / AUDIOGEN_INPUT_SAMPLE_RATE)
  throw new InvalidAudioInputError(
    `${name}${filePath ? ` (${filePath})` : ''} is about ${seconds} s long; ` +
      `the limit is ${AUDIOGEN_INPUT_MAX_SECONDS} s`
  )
}

function nonFiniteError(name: AudioGenAudioInputName) {
  return new InvalidAudioInputError(`${name} must contain only finite samples`)
}
