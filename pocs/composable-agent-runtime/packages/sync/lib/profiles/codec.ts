export function encodeProfileValue(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(toJsonValue(value)))
}

export function decodeProfileValue<Value>(encoded: Buffer): Value {
  return JSON.parse(encoded.toString(), (_key, candidate) => {
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
