/**
 * Wire codec for TTS audio frames. The engines produce signed 16-bit mono
 * PCM; a frame carries it as base64 of the little-endian sample bytes in
 * `pcm` (2 bytes per sample, 2.7 characters once encoded) instead of a JSON
 * `number[]` (about 6 characters per sample, parsed one number at a time).
 * Consumers decode at the boundary so `buffer: number[]` stays the public
 * shape everywhere above it.
 */

type BufferCtor = {
  from(
    data: ArrayBuffer | string,
    encodingOrOffset?: string | number,
    length?: number
  ): {
    toString(encoding: string): string
    buffer: ArrayBuffer
    byteOffset: number
    byteLength: number
  }
}

function bufferCtor(): BufferCtor | undefined {
  const b = (globalThis as { Buffer?: BufferCtor }).Buffer
  return typeof b?.from === 'function' ? b : undefined
}

function toInt16(samples: ArrayLike<number>): Int16Array {
  return samples instanceof Int16Array ? samples : Int16Array.from(samples)
}

/** Base64 of the little-endian int16 bytes of `samples`. */
export function encodeTtsPcm(samples: ArrayLike<number>, Buffer = bufferCtor()): string {
  const int16 = toInt16(samples)
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  if (Buffer) {
    return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString(
      'base64'
    )
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  }
  return btoa(binary)
}

/** The samples a `pcm` field carries, as a typed little-endian int16 view. */
export function decodeTtsPcm(pcm: string, Buffer = bufferCtor()): Int16Array {
  let bytes: Uint8Array
  if (Buffer) {
    const b = Buffer.from(pcm, 'base64')
    bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  } else {
    const binary = atob(pcm)
    bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  }
  const even = bytes.byteLength - (bytes.byteLength % 2)
  if (bytes.byteOffset % 2 !== 0) bytes = bytes.slice(0, even)
  return new Int16Array(bytes.buffer, bytes.byteOffset, even / 2)
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
