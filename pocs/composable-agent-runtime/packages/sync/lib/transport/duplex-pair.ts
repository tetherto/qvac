import { Duplex } from 'streamx'

export function duplexPair(): [Duplex, Duplex] {
  let left: Duplex
  let right: Duplex
  left = new Duplex({
    write(data: Buffer, cb: (error: Error | null) => void) {
      right.push(data)
      cb(null)
    },
    final(cb: (error: Error | null) => void) {
      right.push(null)
      cb(null)
    },
    destroy(cb: (error: Error | null) => void) {
      right.destroy()
      cb(null)
    }
  })
  right = new Duplex({
    write(data: Buffer, cb: (error: Error | null) => void) {
      left.push(data)
      cb(null)
    },
    final(cb: (error: Error | null) => void) {
      left.push(null)
      cb(null)
    },
    destroy(cb: (error: Error | null) => void) {
      left.destroy()
      cb(null)
    }
  })
  return [left, right]
}
