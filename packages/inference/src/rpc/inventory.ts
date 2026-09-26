import net from 'bare-net'
import { Buffer } from 'bare-buffer'
import type { AbortSignal } from 'bare-abort-controller'
import type { DisposableScope } from '@/runtime/disposable-scope'
import type { RpcDevice } from '@/schemas/rpc-server'
import { InferenceCancelledError } from '@/errors/index'
import { throwIfAborted } from './network'

// QVAC RPC 108/109 share these inventory messages. Zero capabilities keep TCP.
const HELLO = 14
const DEVICE_COUNT = 15
const GET_DEVICE_MEMORY = 11
const MAX_DEVICES = 128

export function queryRpcDevices(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
  scope?: DisposableScope
): Promise<RpcDevice[] | undefined> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const devices: RpcDevice[] = []
    let pending = Buffer.alloc(0)
    let command = HELLO
    let responseSize = 28
    let count = 0
    let finished = false
    const timer = setTimeout(() => finish(), timeoutMs)
    const abort = () => finish(undefined, new InferenceCancelledError('rpc'))
    function finish(result?: RpcDevice[], error?: Error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    function send(cmd: number, payload: Buffer, size: number) {
      command = cmd
      responseSize = size
      const frame = Buffer.alloc(9 + payload.length)
      frame[0] = cmd
      frame.writeBigUInt64LE(BigInt(payload.length), 1)
      payload.copy(frame, 9)
      socket.write(frame)
    }
    function memory() {
      const payload = Buffer.alloc(4)
      payload.writeUInt32LE(devices.length)
      send(GET_DEVICE_MEMORY, payload, 16)
    }
    signal.addEventListener('abort', abort, { once: true })
    scope?.defer(() => finish())
    socket.on('error', () => finish())
    socket.on('close', () => finish())
    socket.on('connect', () => send(HELLO, Buffer.alloc(24), 28))
    socket.on('data', (chunk) => {
      if (finished) return
      if (!Buffer.isBuffer(chunk)) return finish()
      // One bounded response per request; reject excess bytes before allocating.
      if (pending.length + chunk.length > 8 + responseSize) return finish()
      pending = Buffer.concat([pending, chunk])
      if (pending.length < 8) return
      if (pending.readBigUInt64LE(0) !== BigInt(responseSize)) return finish()
      if (pending.length < 8 + responseSize) return
      const payload = Buffer.from(pending.subarray(8))
      pending = Buffer.alloc(0)
      if (command === HELLO) {
        if ((payload[0] !== 108 && payload[0] !== 109) || payload[1] !== 0) return finish()
        send(DEVICE_COUNT, Buffer.alloc(0), 4)
      } else if (command === DEVICE_COUNT) {
        count = payload.readUInt32LE(0)
        if (count > MAX_DEVICES) return finish()
        if (count === 0) return finish([])
        memory()
      } else {
        const freeMemory = Number(payload.readBigUInt64LE(0))
        const totalMemory = Number(payload.readBigUInt64LE(8))
        if (!Number.isSafeInteger(freeMemory) || !Number.isSafeInteger(totalMemory)) return finish()
        devices.push({ index: devices.length, freeMemory, totalMemory })
        if (devices.length === count) return finish(devices)
        memory()
      }
    })
    try {
      socket.connect(port, host)
    } catch {
      finish()
    }
  })
}
