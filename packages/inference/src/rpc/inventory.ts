import net from 'bare-net'
import { Buffer } from 'bare-buffer'
import type { AbortSignal } from 'bare-abort-controller'
import type { DisposableScope } from '@/runtime/disposable-scope'
import type { RpcDevice, RpcServerCandidate } from '@/schemas/rpc-server'
import { InferenceCancelledError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { throwIfAborted } from './network'

// Fabric RPC_PROTO_*_VERSION:
// https://github.com/tetherto/qvac-fabric-llm.cpp/blob/v10549.5.0/ggml/include/ggml-rpc.h
// Command IDs and HELLO layouts, rpc_cmd and rpc_msg_hello_*:
// https://github.com/tetherto/qvac-fabric-llm.cpp/blob/v10549.5.0/ggml/src/ggml-rpc/ggml-rpc.cpp
// QVAC RPC 108.0/109.0 share these inventory messages. Patch versions are compatible.
const SUPPORTED_VERSIONS = [
  { major: 108, minor: 0 },
  { major: 109, minor: 0 }
]
const SUPPORTED_VERSION_LABEL = SUPPORTED_VERSIONS.map(
  ({ major, minor }) => `${major}.${minor}.x`
).join(', ')
const HELLO = 14
const HELLO_REQUEST_SIZE = 24
const HELLO_RESPONSE_SIZE = 28
const DEVICE_COUNT = 15
const GET_DEVICE_MEMORY = 11
const MAX_DEVICES = 128

export type RpcInventory = Pick<RpcServerCandidate, 'devices' | 'rdmaAvailable'>

export function queryRpcInventory(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
  scope?: DisposableScope
): Promise<RpcInventory | undefined> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const devices: RpcDevice[] = []
    let pending = Buffer.alloc(0)
    let command = HELLO
    let responseSize = HELLO_RESPONSE_SIZE
    let count = 0
    let rdmaAvailable = false
    let finished = false
    const timer = setTimeout(() => finish(), timeoutMs)
    const abort = () => finish(undefined, new InferenceCancelledError('rpc'))
    function finish(result?: RpcInventory, error?: Error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    function rejectHello(reason: string, chunk = Buffer.alloc(0)) {
      // Read only the length and version prefix, even for an oversized chunk.
      const prefix = Buffer.alloc(Math.min(11, pending.length + chunk.length))
      const copied = pending.copy(prefix, 0, 0, prefix.length)
      chunk.copy(prefix, copied, 0, prefix.length - copied)
      const size = prefix.length >= 8 ? prefix.readBigUInt64LE(0) : undefined
      const version =
        size !== undefined && size >= 3n && prefix.length >= 11
          ? `${prefix[8]}.${prefix[9]}.${prefix[10]}`
          : 'unavailable'
      getEngineLogger().warn('RPC inventory HELLO rejected', {
        url: `${host}:${port}`,
        reason,
        receivedVersion: version,
        supportedVersions: SUPPORTED_VERSION_LABEL,
        receivedHelloBytes: size?.toString() ?? 'unavailable',
        expectedHelloBytes: HELLO_RESPONSE_SIZE
      })
      finish()
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
    // Zero capabilities keep this probe on TCP.
    socket.on('connect', () => send(HELLO, Buffer.alloc(HELLO_REQUEST_SIZE), HELLO_RESPONSE_SIZE))
    socket.on('data', (chunk) => {
      if (finished) return
      if (!Buffer.isBuffer(chunk)) return finish()
      // One bounded response per request; reject excess bytes before allocating.
      if (pending.length + chunk.length > 8 + responseSize) {
        if (command === HELLO) return rejectHello('response exceeds frame limit', chunk)
        return finish()
      }
      pending = Buffer.concat([pending, chunk])
      if (pending.length < 8) return
      if (pending.readBigUInt64LE(0) !== BigInt(responseSize)) {
        if (command === HELLO) return rejectHello('unexpected response size')
        return finish()
      }
      if (pending.length < 8 + responseSize) return
      if (
        command === HELLO &&
        !SUPPORTED_VERSIONS.some(({ major, minor }) => pending[8] === major && pending[9] === minor)
      ) {
        return rejectHello('unsupported protocol version')
      }
      const payload = Buffer.from(pending.subarray(8))
      pending = Buffer.alloc(0)
      if (command === HELLO) {
        // QPN follows the four version/padding bytes. The probe itself stays on TCP.
        rdmaAvailable = payload.readUInt32LE(4) !== 0
        send(DEVICE_COUNT, Buffer.alloc(0), 4)
      } else if (command === DEVICE_COUNT) {
        count = payload.readUInt32LE(0)
        if (count > MAX_DEVICES) return finish()
        if (count === 0) return finish({ devices, rdmaAvailable })
        memory()
      } else {
        const freeMemory = Number(payload.readBigUInt64LE(0))
        const totalMemory = Number(payload.readBigUInt64LE(8))
        if (!Number.isSafeInteger(freeMemory) || !Number.isSafeInteger(totalMemory)) return finish()
        devices.push({ index: devices.length, freeMemory, totalMemory })
        if (devices.length === count) return finish({ devices, rdmaAvailable })
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
