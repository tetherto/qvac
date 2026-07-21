import { Duplex } from 'streamx'

export interface HarnessStream {
  on(event: 'close', listener: () => void): object
  destroy(): void
}

export type HarnessTransport = () => HarnessStream | Promise<HarnessStream>

export function duplexPair(): [Duplex, Duplex] {
  let left: Duplex
  let right: Duplex
  left = new Duplex({
    write(data: Uint8Array, callback: (error: Error | null) => void) {
      right.push(data)
      callback(null)
    },
    final(callback: (error: Error | null) => void) {
      right.push(null)
      callback(null)
    },
    destroy(callback: (error: Error | null) => void) {
      if (!right.destroyed) right.destroy()
      callback(null)
    }
  })
  right = new Duplex({
    write(data: Uint8Array, callback: (error: Error | null) => void) {
      left.push(data)
      callback(null)
    },
    final(callback: (error: Error | null) => void) {
      left.push(null)
      callback(null)
    },
    destroy(callback: (error: Error | null) => void) {
      if (!left.destroyed) left.destroy()
      callback(null)
    }
  })
  return [left, right]
}
