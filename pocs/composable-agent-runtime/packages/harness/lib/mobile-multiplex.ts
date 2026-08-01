import { Duplex } from 'streamx'

export interface CarrierStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  write(chunk: Uint8Array): unknown
  destroy?(error?: Error): void
}

interface ChannelState {
  readonly queue: Uint8Array[]
  readonly waiters: Array<() => void>
  readonly stream: Duplex
  ended: boolean
}

export interface BinaryChannelMultiplexer {
  openChannel(channelId: number): Duplex
  close(): void
}

interface MultiplexerOptions {
  readonly onUnknownChannel?: (frame: {
    readonly channelId: number
    readonly payload: Uint8Array
  }) => void
}

const HEADER_BYTES = 5

export function createBinaryChannelMultiplexer(
  carrier: CarrierStream,
  { onUnknownChannel }: MultiplexerOptions = {}
): BinaryChannelMultiplexer {
  const channels = new Map<number, ChannelState>()
  let buffered = new Uint8Array(0)
  let closed = false

  carrier.on('data', (chunk) => {
    if (!(chunk instanceof Uint8Array)) return
    buffered = concatBytes(buffered, chunk)
    while (buffered.byteLength >= HEADER_BYTES) {
      const channelId = buffered[0] ?? 0
      const payloadLength = readLength(buffered)
      const frameLength = HEADER_BYTES + payloadLength
      if (buffered.byteLength < frameLength) break
      const payload = buffered.slice(HEADER_BYTES, frameLength)
      buffered = buffered.slice(frameLength)
      if (channelId === 0) continue
      pushChannel(channelId, payload)
    }
  })
  carrier.on('close', () => {
    closeAll()
  })
  carrier.on('error', () => {
    closeAll()
  })

  return {
    openChannel(channelId: number) {
      if (channelId < 1 || channelId > 255) {
        throw new Error('channelId must be between 1 and 255')
      }
      const existing = channels.get(channelId)
      if (existing) return existing.stream
      const stream = new Duplex({
        highWaterMark: 0,
        read(callback) {
          const state = ensureChannel(channelId)
          if (!state) {
            callback(new Error(`logical channel ${channelId} is not open`))
            return
          }
          if (state.queue.length > 0) {
            this.push(state.queue.shift() ?? null)
            callback(null)
            return
          }
          if (state.ended) {
            this.push(null)
            callback(null)
            return
          }
          state.waiters.push(() => {
            if (state.queue.length > 0) {
              this.push(state.queue.shift() ?? null)
            } else if (state.ended) {
              this.push(null)
            }
            callback(null)
          })
        },
        write(chunk, callback) {
          if (!(chunk instanceof Uint8Array)) {
            callback(new Error('logical channel writes Uint8Array payloads only'))
            return
          }
          if (closed) {
            callback(new Error('multiplexer is closed'))
            return
          }
          const frame = encodeFrame(channelId, chunk)
          carrier.write(frame)
          callback(null)
        },
        destroy(callback) {
          const state = ensureChannel(channelId)
          if (!state) {
            callback(null)
            return
          }
          state.ended = true
          for (const wake of state.waiters.splice(0)) wake()
          callback(null)
        }
      })
      channels.set(channelId, {
        queue: [],
        waiters: [],
        ended: false,
        stream
      })
      return stream
    },
    close() {
      closeAll()
      carrier.destroy?.()
    }
  }

  function ensureChannel(channelId: number) {
    const existing = channels.get(channelId)
    if (existing) return existing
    return null
  }

  function pushChannel(channelId: number, payload: Uint8Array) {
    const state = ensureChannel(channelId)
    if (!state) {
      onUnknownChannel?.({ channelId, payload })
      return
    }
    if (state.ended) return
    state.queue.push(payload)
    const wake = state.waiters.shift()
    wake?.()
  }

  function closeAll() {
    if (closed) return
    closed = true
    for (const state of channels.values()) {
      state.ended = true
      for (const wake of state.waiters.splice(0)) wake()
      state.stream.destroy()
    }
  }
}

function readLength(frame: Uint8Array) {
  return (
    ((frame[1] ?? 0) << 24) |
    ((frame[2] ?? 0) << 16) |
    ((frame[3] ?? 0) << 8) |
    (frame[4] ?? 0)
  )
}

function encodeFrame(channelId: number, payload: Uint8Array) {
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength)
  frame[0] = channelId
  frame[1] = ((payload.byteLength >>> 24) & 0xff) as number
  frame[2] = ((payload.byteLength >>> 16) & 0xff) as number
  frame[3] = ((payload.byteLength >>> 8) & 0xff) as number
  frame[4] = (payload.byteLength & 0xff) as number
  frame.set(payload, HEADER_BYTES)
  return frame
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const merged = new Uint8Array(left.byteLength + right.byteLength)
  merged.set(left, 0)
  merged.set(right, left.byteLength)
  return merged
}
