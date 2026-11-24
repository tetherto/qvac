/**
 * Wire codec for TTS audio frames. The engines produce signed 16-bit mono
 * PCM; a frame carries it as base64 of the little-endian sample bytes in
 * `pcm` (2 bytes per sample, 2.7 characters once encoded) instead of a JSON
 * `number[]` (about 6 characters per sample, parsed one number at a time).
 * Consumers decode at the boundary so `buffer: number[]` stays the public
 * shape everywhere above it.
 */

import {
  base64ToOwnedBytes,
  typedArrayToBase64,
  type BufferFromArrayBuffer,
  type BufferFromBase64
} from '@/utils/encoding'

function toInt16(samples: ArrayLike<number>): Int16Array {
  return samples instanceof Int16Array ? samples : Int16Array.from(samples)
}

/** Base64 of the little-endian int16 bytes of `samples`. */
export function encodeTtsPcm(samples: ArrayLike<number>, Buffer?: BufferFromArrayBuffer): string {
  return typedArrayToBase64(toInt16(samples), Buffer)
}

/**
 * The samples a `pcm` field carries, as little-endian int16. The result always
 * owns its bytes (`byteOffset` 0, buffer exactly its size), so a caller doing
 * `new Int16Array(result.buffer)` never reads a shared Buffer pool.
 */
export function decodeTtsPcm(pcm: string, Buffer?: BufferFromBase64): Int16Array {
  const bytes = base64ToOwnedBytes(pcm, 2, Buffer)
  return new Int16Array(bytes.buffer, 0, bytes.byteLength / 2)
}

/**
 * The frame with its audio in `buffer` whatever the wire carried: a frame
 * that arrived with `pcm` gets the decoded samples and loses the field, one
 * that arrived with `buffer` is returned as is.
 */
export function withDecodedTtsPcm<T extends { buffer: number[]; pcm?: string | undefined }>(
  frame: T
): T {
  if (frame.pcm === undefined) return frame
  const { pcm, ...rest } = frame
  const int16 = decodeTtsPcm(pcm)
  // A preallocated loop is ~10x faster than Array.from over a typed array.
  const buffer = new Array<number>(int16.length)
  for (let i = 0; i < int16.length; i++) buffer[i] = int16[i]!
  return { ...rest, buffer } as T
}
