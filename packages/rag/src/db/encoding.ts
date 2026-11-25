import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import type { VectorEncoding } from '../types.js'

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

// Vectors are stored as little-endian float32 or float16 bytes, per namespace.
export const DEFAULT_VECTOR_ENCODING: VectorEncoding = 'f32'

// The largest finite float16.
export const F16_MAX = 65504

export function vectorBytes(encoding: VectorEncoding): number {
  return encoding === 'f16' ? 2 : 4
}

export function encodeVector(vector: Float32Array, encoding: VectorEncoding): Uint8Array {
  const width = vectorBytes(encoding)
  const bytes = new Uint8Array(vector.length * width)
  const view = new DataView(bytes.buffer)
  if (width === 4) {
    for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true)
  } else {
    for (let i = 0; i < vector.length; i++) view.setUint16(i * 2, toHalf(vector[i]), true)
  }
  return bytes
}

// Decodes into `target` at `offset` so a search batch reuses one buffer. The
// width follows from the byte length, so callers check it against the dimensions.
export function decodeVectorInto(
  bytes: Uint8Array,
  target: Float32Array,
  offset: number,
  dims: number
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength === dims * 4) {
    for (let i = 0; i < dims; i++) target[offset + i] = view.getFloat32(i * 4, true)
  } else {
    const halves = halfTable()
    for (let i = 0; i < dims; i++) target[offset + i] = halves[view.getUint16(i * 2, true)]
  }
}

// Rounds `vector` in place to the values `encoding` stores, so hashes, the
// index and later reads all see the same numbers.
export function roundToEncoding(vector: Float32Array, encoding: VectorEncoding): void {
  if (encoding === 'f32') return
  const halves = halfTable()
  for (let i = 0; i < vector.length; i++) vector[i] = halves[toHalf(vector[i])]
}

const scratch = new Float32Array(1)
const scratchBits = new Uint32Array(scratch.buffer)

// float32 → float16 bits, rounding to nearest even. Overflow gives ±Infinity.
export function toHalf(value: number): number {
  scratch[0] = value
  const bits = scratchBits[0]
  const sign = (bits >>> 16) & 0x8000
  const exponent = (bits >>> 23) & 0xff
  const mantissa = bits & 0x7fffff
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00)
  const halfExponent = exponent - 112
  if (halfExponent >= 0x1f) return sign | 0x7c00
  if (halfExponent <= 0) {
    // Subnormal: count in units of 2^-24, the smallest float16 step.
    const shift = 126 - exponent
    if (shift > 24) return sign
    const full = mantissa | 0x800000
    let half = full >>> shift
    const rest = full & ((1 << shift) - 1)
    const midpoint = 1 << (shift - 1)
    if (rest > midpoint || (rest === midpoint && half & 1)) half++
    return sign | half
  }
  let half = (halfExponent << 10) | (mantissa >>> 13)
  const rest = mantissa & 0x1fff
  // A carry out of the mantissa bumps the exponent, up to Infinity.
  if (rest > 0x1000 || (rest === 0x1000 && half & 1)) half++
  return sign | half
}

export function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >>> 10) & 0x1f
  const mantissa = bits & 0x3ff
  if (exponent === 0) return sign * mantissa * 2 ** -24
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
}

let table: Float32Array | null = null

function halfTable(): Float32Array {
  if (!table) {
    table = new Float32Array(0x10000)
    for (let bits = 0; bits < 0x10000; bits++) table[bits] = fromHalf(bits)
  }
  return table
}
