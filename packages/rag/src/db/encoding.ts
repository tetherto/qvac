import { QvacErrorRAG, ERR_CODES } from '../errors.js'

// UINT64_MAX is reserved, so the last assignable native ID is one below it.
export const MAX_NATIVE_ID = 0xffffffffffffffffn - 1n
export const FIRST_NATIVE_ID = 1n

export function encodeNativeId(id: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, id, false)
  return bytes
}

export function decodeNativeId(bytes: Uint8Array): bigint {
  if (bytes.byteLength !== 8) {
    throw new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: `native ID must be 8 bytes, got ${bytes.byteLength}`
    })
  }
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false)
}

export function packNativeIds(ids: bigint[]): Uint8Array {
  const bytes = new Uint8Array(ids.length * 8)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < ids.length; i++) view.setBigUint64(i * 8, ids[i], false)
  return bytes
}

export function unpackNativeIds(bytes: Uint8Array): bigint[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ids: bigint[] = []
  for (let offset = 0; offset + 8 <= bytes.byteLength; offset += 8) {
    ids.push(view.getBigUint64(offset, false))
  }
  return ids
}

// Vectors are stored as little-endian float32 bytes.
export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true)
  return bytes
}

// Decodes into `target` at `offset` so a search batch reuses one buffer.
export function decodeVectorInto(bytes: Uint8Array, target: Float32Array, offset: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = bytes.byteLength / 4
  for (let i = 0; i < length; i++) target[offset + i] = view.getFloat32(i * 4, true)
}
