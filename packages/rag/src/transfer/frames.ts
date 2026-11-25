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

// Import refuses frames over MAX_FRAME_BYTES, so export fails rather than
// write a stream that can't be restored.
export function encodeFrame(type: number, payload: Uint8Array, what = 'a frame'): Uint8Array {
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: `${what} encodes to ${payload.byteLength} bytes, over the ${MAX_FRAME_BYTES} byte export limit`
    })
  }
  const frame = new Uint8Array(FRAME_HEAD_BYTES + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, payload.byteLength, true)
  view.setUint8(4, type)
  frame.set(payload, FRAME_HEAD_BYTES)
  return frame
}

export function jsonFrame(type: number, value: unknown, what?: string): Uint8Array {
  return encodeFrame(type, encodeJson(value), what)
}

// [u32 LE JSON length][JSON][vector bytes]
export function chunkFrame(fields: unknown, vector: Uint8Array, what?: string): Uint8Array {
  const json = encodeJson(fields)
  const payload = new Uint8Array(4 + json.byteLength + vector.byteLength)
  new DataView(payload.buffer).setUint32(0, json.byteLength, true)
  payload.set(json, 4)
  payload.set(vector, 4 + json.byteLength)
  return encodeFrame(FRAME.CHUNK, payload, what)
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

// Ends a read the source never answers. `halt()` sets `stopped` and calls
// `wake`, which the reader sets while it waits on the source.
export interface ReadStop {
  stopped: boolean
  wake: (() => void) | null
}

// Holds at most one frame plus one source chunk: bytes are copied into the
// frame as they arrive. Once `stop` is halted, reads fail with
// OPERATION_CANCELLED, including one already waiting on the source.
export function createFrameReader(source: AsyncIterable<Uint8Array>, stop?: ReadStop): FrameReader {
  const iterator = source[Symbol.asyncIterator]()
  let carry: Uint8Array | null = null
  let done = false

  async function nextChunk(): Promise<IteratorResult<Uint8Array>> {
    if (!stop) {
      try {
        return await iterator.next()
      } catch (error) {
        throw sourceFailed(error)
      }
    }
    if (stop.stopped) throw cancelled()
    try {
      // `wake` is set first: the source may itself trigger the stop inside `next()`.
      return await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        stop.wake = () => reject(cancelled())
        Promise.resolve()
          .then(() => iterator.next())
          .then(resolve, (error: unknown) => reject(sourceFailed(error)))
      })
    } finally {
      stop.wake = null
    }
  }

  async function pull(): Promise<Uint8Array | null> {
    while (!done) {
      const { value, done: finished } = await nextChunk()
      if (finished) {
        done = true
        break
      }
      if (!(value instanceof Uint8Array)) throw invalid('the source must yield Uint8Array chunks')
      if (value.byteLength > 0) return value
    }
    return null
  }

  // Returns how many bytes arrived before the source ended.
  async function read(out: Uint8Array): Promise<number> {
    let got = 0
    while (got < out.byteLength) {
      if (!carry) carry = await pull()
      if (!carry) break
      const used = Math.min(carry.byteLength, out.byteLength - got)
      out.set(carry.subarray(0, used), got)
      got += used
      carry = used === carry.byteLength ? null : carry.subarray(used)
    }
    return got
  }

  return {
    async readMagic() {
      const magic = new Uint8Array(MAGIC.byteLength)
      const got = await read(magic)
      if (got < magic.byteLength || !magic.every((byte, i) => byte === MAGIC[i])) {
        throw invalid('not a QVRAGX1 stream')
      }
    },

    async next() {
      const head = new Uint8Array(FRAME_HEAD_BYTES)
      const got = await read(head)
      if (got === 0) return null
      if (got < FRAME_HEAD_BYTES) throw invalid('the stream ends inside a frame header')
      const view = new DataView(head.buffer)
      const length = view.getUint32(0, true)
      const type = view.getUint8(4)
      if (length > MAX_FRAME_BYTES) {
        throw invalid(`a frame of ${length} bytes is over the ${MAX_FRAME_BYTES} byte limit`)
      }
      const payload = new Uint8Array(length)
      if ((await read(payload)) < length) throw invalid('the stream ends inside a frame')
      return { type, payload }
    },

    // A source stuck in `next()` can't finish `return()` either, so a stopped
    // reader doesn't wait for it.
    async close() {
      if (done) return
      done = true
      const returning = Promise.resolve(iterator.return?.())
      if (stop?.stopped) returning.catch(() => {})
      else await returning
    }
  }
}

// The source's own error is kept as `cause`.
function sourceFailed(error: unknown): QvacErrorRAG {
  if (error instanceof QvacErrorRAG) return error
  return new QvacErrorRAG({
    code: ERR_CODES.IMPORT_SOURCE_FAILED,
    adds: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error ? error : undefined
  })
}

function cancelled(): QvacErrorRAG {
  return new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
}

export function invalid(message: string): QvacErrorRAG {
  return new QvacErrorRAG({ code: ERR_CODES.IMPORT_INVALID, adds: message })
}
