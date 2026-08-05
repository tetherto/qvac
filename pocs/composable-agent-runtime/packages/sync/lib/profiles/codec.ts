export function encodeProfileValue(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(toJsonValue(value)))
}

/**
 * Encoded values arrive as a Buffer on Bare and Node but as a plain Uint8Array
 * across the mobile worklet boundary, and Uint8Array.toString() yields
 * comma-joined byte values rather than text. Decode explicitly so a profile
 * value parses the same on every host.
 */
function decodeUtf8(encoded: Buffer | Uint8Array | string) {
  if (typeof encoded === 'string') return encoded
  // Buffer.from normalises a plain Uint8Array into a Buffer whose toString
  // decodes text. TextDecoder is not available on Hermes.
  return Buffer.from(
    encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded)
  ).toString('utf8')
}

export function decodeProfileValue<Value>(encoded: Buffer): Value {
  return JSON.parse(decodeUtf8(encoded), (_key, candidate) => {
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.$syncBuffer === 'string'
    ) {
      return Buffer.from(candidate.$syncBuffer, 'base64')
    }
    return candidate
  }) as Value
}

function toJsonValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { $syncBuffer: value.toString('base64') }
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $syncBuffer: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
      ).toString('base64')
    }
  }
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (value == null || typeof value !== 'object') return value
  const encoded: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    encoded[key] = toJsonValue(Reflect.get(value, key))
  }
  return encoded
}
