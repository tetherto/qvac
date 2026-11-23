/**
 * Decodes a base64 string to a Uint8Array.
 *
 * Uses atob which is available across all runtimes (Node, Bare, React Native).
 * Buffer is not globally available in React Native (Hermes engine), so this
 * provides a cross-platform alternative to Buffer.from(str, "base64").
 */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Encodes a Uint8Array to a base64 string.
 *
 * Uses btoa which is available across all runtimes (Node, Bare, React Native).
 * Buffer is not globally available in React Native (Hermes engine), so this
 * provides a cross-platform alternative to Buffer.from(bytes).toString("base64").
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

/** The `Buffer.from(arrayBuffer, offset, length)` overload `typedArrayToBase64` uses. */
export type BufferFromArrayBuffer = {
  from(
    arrayBuffer: ArrayBuffer,
    offset: number,
    length: number
  ): { toString(encoding: 'base64'): string }
}

/** The `Buffer.from(string, 'base64')` overload `base64ToOwnedBytes` uses. */
export type BufferFromBase64 = {
  from(
    value: string,
    encoding: 'base64'
  ): { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }
}

// Node and Electron have a global Buffer; Bare and React Native do not.
function globalBuffer(): (BufferFromArrayBuffer & BufferFromBase64) | undefined {
  const b = (globalThis as { Buffer?: BufferFromArrayBuffer & BufferFromBase64 }).Buffer
  return typeof b?.from === 'function' ? b : undefined
}

/**
 * Base64 of the bytes behind `view`, such as a typed array's elements in
 * platform (little-endian) byte order.
 *
 * Pass `Buffer` (for example `bare-buffer`) for the fast path; it defaults to
 * the global Buffer when there is one.
 */
export function typedArrayToBase64(
  view: ArrayBufferView,
  Buffer: BufferFromArrayBuffer | undefined = globalBuffer()
): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
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

/**
 * The bytes `value` encodes, cut to a whole number of `elementSize`-byte
 * elements. The result always owns its buffer (`byteOffset` 0, buffer exactly
 * its size), so a typed array over `result.buffer` reads only these bytes.
 * Runtimes hand small Buffer decodes back as a view into a shared pool, which
 * is why the bytes are copied unless the view already owns them.
 *
 * `Buffer` works as in `typedArrayToBase64`.
 */
export function base64ToOwnedBytes(
  value: string,
  elementSize: number,
  Buffer: BufferFromBase64 | undefined = globalBuffer()
): Uint8Array {
  let bytes: Uint8Array
  if (Buffer) {
    const b = Buffer.from(value, 'base64')
    bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  } else {
    bytes = decodeBase64(value)
  }
  const length = bytes.byteLength - (bytes.byteLength % elementSize)
  const ownsBytes = bytes.byteOffset === 0 && bytes.buffer.byteLength === length
  return ownsBytes ? bytes : bytes.slice(0, length)
}
