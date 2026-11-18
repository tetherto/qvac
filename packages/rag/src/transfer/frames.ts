import { QvacErrorRAG, ERR_CODES } from '../errors.js'

// `QVRAGX1` stream: this magic, then frames of [u32 LE payload length][u8 type]
// [payload]. Text fields are JSON; a chunk frame's vector is raw float32 LE.
export const MAGIC = new Uint8Array([0x51, 0x56, 0x52, 0x41, 0x47, 0x58, 0x31, 0x0a]) // "QVRAGX1\n"
export const FORMAT_VERSION = 1

export const FRAME = Object.freeze({
  HEADER: 1,
  DOCUMENT: 2,
  CHUNK: 3,
  TOMBSTONE: 4,
  TRAILER: 5
})

// Guards against a corrupt length asking for gigabytes.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

const FRAME_HEAD_BYTES = 5

// Frame JSON is ASCII: anything else is written as a \u escape, so no text
// codec is needed on runtimes without TextEncoder.
function encodeJson(value: unknown): Uint8Array {
  const text = JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
  )
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

function decodeAscii(bytes: Uint8Array): string {
  let text = ''
  for (let start = 0; start < bytes.byteLength; start += 8192) {
    const slice = bytes.subarray(start, start + 8192)
    if (slice.some((byte) => byte > 0x7e)) throw invalid('a frame holds non-ASCII JSON')
    text += String.fromCharCode(...slice)
  }
  return text
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEAD_BYTES + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, payload.byteLength, true)
  view.setUint8(4, type)
  frame.set(payload, FRAME_HEAD_BYTES)
  return frame
}

export function jsonFrame(type: number, value: unknown): Uint8Array {
  return encodeFrame(type, encodeJson(value))
}

// [u32 LE JSON length][JSON][vector bytes]
export function chunkFrame(fields: unknown, vector: Uint8Array): Uint8Array {
  const json = encodeJson(fields)
  const payload = new Uint8Array(4 + json.byteLength + vector.byteLength)
  new DataView(payload.buffer).setUint32(0, json.byteLength, true)
  payload.set(json, 4)
  payload.set(vector, 4 + json.byteLength)
  return encodeFrame(FRAME.CHUNK, payload)
}

export function splitChunkPayload(payload: Uint8Array): { fields: unknown; vector: Uint8Array } {
  if (payload.byteLength < 4) throw invalid('chunk frame is too short')
  const length = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true)
  if (4 + length > payload.byteLength) throw invalid('chunk frame JSON overruns the frame')
  return {
    fields: parseJson(payload.subarray(4, 4 + length)),
    vector: payload.subarray(4 + length)
  }
}

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeAscii(bytes))
  } catch (error) {
    if (error instanceof QvacErrorRAG) throw error
    throw invalid('a frame holds malformed JSON')
  }
}

export interface Frame {
  type: number
  payload: Uint8Array
}

export interface FrameReader {
  // Fails unless the stream starts with MAGIC.
  readMagic(): Promise<void>
  // Null only at a clean end between frames; a stream cut inside a frame fails.
  next(): Promise<Frame | null>
  // Lets the source release what it holds when reading stops early.
  close(): Promise<void>
}

// Holds at most one frame plus one source chunk.
export function createFrameReader(source: AsyncIterable<Uint8Array>): FrameReader {
  const iterator = source[Symbol.asyncIterator]()
  const pending: Uint8Array[] = []
  let buffered = 0
  let done = false

  async function fill(bytes: number): Promise<boolean> {
    while (buffered < bytes && !done) {
      const { value, done: finished } = await iterator.next()
      if (finished) {
        done = true
        break
      }
      if (!(value instanceof Uint8Array)) throw invalid('the source must yield Uint8Array chunks')
      if (value.byteLength === 0) continue
      pending.push(value)
      buffered += value.byteLength
    }
    return buffered >= bytes
  }

  function take(bytes: number): Uint8Array {
    const out = new Uint8Array(bytes)
    let offset = 0
    while (offset < bytes) {
      const head = pending[0]
      const used = Math.min(head.byteLength, bytes - offset)
      out.set(head.subarray(0, used), offset)
      offset += used
      if (used === head.byteLength) pending.shift()
      else pending[0] = head.subarray(used)
    }
    buffered -= bytes
    return out
  }

  return {
    async readMagic() {
      if (!(await fill(MAGIC.byteLength))) throw invalid('not a QVRAGX1 stream')
      const magic = take(MAGIC.byteLength)
      if (!magic.every((byte, i) => byte === MAGIC[i])) throw invalid('not a QVRAGX1 stream')
    },

    async next() {
      if (!(await fill(FRAME_HEAD_BYTES))) {
        if (buffered === 0) return null
        throw invalid('the stream ends inside a frame header')
      }
      const head = take(FRAME_HEAD_BYTES)
      const view = new DataView(head.buffer)
      const length = view.getUint32(0, true)
      const type = view.getUint8(4)
      if (length > MAX_FRAME_BYTES) {
        throw invalid(`a frame of ${length} bytes is over the ${MAX_FRAME_BYTES} byte limit`)
      }
      if (!(await fill(length))) throw invalid('the stream ends inside a frame')
      return { type, payload: take(length) }
    },

    async close() {
      if (done) return
      done = true
      await iterator.return?.()
    }
  }
}

export function invalid(message: string): QvacErrorRAG {
  return new QvacErrorRAG({ code: ERR_CODES.IMPORT_INVALID, adds: message })
}
