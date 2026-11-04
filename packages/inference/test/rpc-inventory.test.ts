import test from 'brittle'
import net from 'bare-net'
import { Buffer } from 'bare-buffer'
import EventEmitter from 'bare-events'
import { AbortController } from 'bare-abort-controller'
import { queryRpcInventory } from '@/rpc/inventory'
import { discoverRpcEndpoints } from '@/rpc/discovery'
import { rpcTopic } from '@/rpc/network'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { createRequestRegistry } from '@/runtime/request-context'
import type { createLanDiscovery } from '@/rpc/lan'
import { getRpcDeviceMap } from '@/rpc/device-map'
import { InferenceCancelledError } from '@/errors/index'
import { getEngineLogger, LOG_ID } from '@/logging/index'
import { registerLoggingStream, unregisterLoggingStream } from '@/runtime/logging-stream-registry'

function captureWarnings() {
  const warnings: string[] = []
  const logger = getEngineLogger()
  const level = logger.getLevel()
  logger.setLevel('warn')
  const collect = (level: string, _namespace: string, message: string) => {
    if (level === 'warn') warnings.push(message)
  }
  registerLoggingStream(LOG_ID, collect)
  return {
    warnings,
    [Symbol.dispose]() {
      unregisterLoggingStream(LOG_ID, collect)
      logger.setLevel(level)
    }
  }
}

async function endpoint(
  reply: (command: number, payload: Buffer) => Buffer | undefined,
  options: {
    splitAt?: number[]
    transformFrame?: (frame: Buffer) => Buffer
    timeoutMs?: number
  } = {}
) {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk)) return
      pending = Buffer.concat([pending, chunk])
      if (pending.length < 9) return
      const size = Number(pending.readBigUInt64LE(1))
      if (pending.length < size + 9) return
      const response = reply(pending[0]!, Buffer.from(pending.subarray(9)))
      pending = Buffer.alloc(0)
      if (!response) return
      const header = Buffer.alloc(8)
      header.writeBigUInt64LE(BigInt(response.length))
      const responseFrame = Buffer.concat([header, response])
      const frame = options.transformFrame?.(responseFrame) ?? responseFrame
      // Separate writes in time so the tests exercise fragmented headers and payloads.
      const cuts = [
        0,
        ...(options.splitAt ?? [3, 14]).filter((offset) => offset < frame.length),
        frame.length
      ]
      for (let i = 1; i < cuts.length; i++) {
        const part = frame.subarray(cuts[i - 1], cuts[i])
        setTimeout(
          () => {
            if (!socket.destroyed) socket.write(part)
          },
          (i - 1) * 5
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  return {
    url: `127.0.0.1:${address.port}`,
    query: (signal = new AbortController().signal) =>
      queryRpcInventory('127.0.0.1', address.port, options.timeoutMs ?? 5000, signal),
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const device = { index: 0, freeMemory: 1024, totalMemory: 2048 }
const first = {
  url: '10.0.0.2:50052',
  rdmaAvailable: true,
  devices: [device, { ...device, index: 1 }]
}
const second = { url: '10.0.0.3:50052', rdmaAvailable: false, devices: [device] }

test('RPC aliases enumerate all devices before moving to the next endpoint', (t) => {
  const mapped = getRpcDeviceMap([first, second])
  t.alike(
    mapped.map(({ url, index, alias }) => ({ url, index, alias })),
    [
      { url: first.url, index: 0, alias: 'RPC0' },
      { url: first.url, index: 1, alias: 'RPC1' },
      { url: second.url, index: 0, alias: 'RPC2' }
    ]
  )
  t.is(mapped[2]!.totalMemory, 2048)
  t.alike(
    getRpcDeviceMap([first, second, first]),
    mapped,
    'the device map skips repeated candidates'
  )
  t.is(getRpcDeviceMap([second, first])[1]!.url, first.url)
  t.is(getRpcDeviceMap([second, first])[1]!.alias, 'RPC1')
  t.alike(getRpcDeviceMap([]), [])
  t.exception(
    () => getRpcDeviceMap([{ ...first, devices: [{ ...device, index: 1 }] }]),
    /native device order/
  )
})

test('RPC aliases follow only the current load, including on reused workers', (t) => {
  getRpcDeviceMap([first])
  t.alike(
    getRpcDeviceMap([second]).map(({ url, alias }) => ({ url, alias })),
    [{ url: second.url, alias: 'RPC0' }]
  )
  t.alike(
    getRpcDeviceMap([second, first]).map(({ url, alias }) => ({ url, alias })),
    [
      { url: second.url, alias: 'RPC0' },
      { url: first.url, alias: 'RPC1' },
      { url: first.url, alias: 'RPC2' }
    ]
  )
  t.alike(getRpcDeviceMap([first, first, second]), getRpcDeviceMap([first, second]))
})

test('RPC inventory reads native device count and memory over fragmented TCP responses', async (t) => {
  using logs = captureWarnings()
  const commands: number[] = []
  await using server = await endpoint((command, payload) => {
    commands.push(command)
    if (command === 14) {
      t.alike(payload, Buffer.alloc(24), 'TCP-only capabilities')
      const hello = Buffer.alloc(28)
      hello[0] = 112
      return hello
    }
    if (command === 15) {
      t.is(payload.length, 0)
      const count = Buffer.alloc(4)
      count.writeUInt32LE(2)
      return count
    }
    t.is(command, 11)
    const index = payload.readUInt32LE(0)
    const memory = Buffer.alloc(16)
    memory.writeBigUInt64LE(BigInt(1024 + index), 0)
    memory.writeBigUInt64LE(2048n, 8)
    return memory
  })
  t.alike(await server.query(), {
    devices: [device, { ...device, index: 1, freeMemory: 1025 }],
    rdmaAvailable: false
  })
  t.alike(commands, [14, 15, 11, 11])
  t.alike(logs.warnings, [], 'compatible inventory does not warn')
})

for (const patch of [0, 1, 255]) {
  for (const qpn of [0, 0x123456]) {
    test(`RPC 112.0.${patch} inventory reports RDMA availability for QPN ${qpn}`, async (t) => {
      await using server = await endpoint((command, payload) => {
        if (command === 14) {
          t.alike(payload, Buffer.alloc(24), 'probe requests TCP even when server offers RDMA')
          const hello = Buffer.alloc(28)
          hello[0] = 112
          hello[2] = patch
          hello.writeUInt32LE(qpn, 4)
          hello.fill(255, 8)
          return hello
        }
        if (command === 15) {
          const count = Buffer.alloc(4)
          count.writeUInt32LE(1)
          return count
        }
        const memory = Buffer.alloc(16)
        memory.writeBigUInt64LE(1024n, 0)
        memory.writeBigUInt64LE(2048n, 8)
        return memory
      })
      t.alike(await server.query(), { devices: [device], rdmaAvailable: qpn !== 0 })
    })
  }
}

test('RPC inventory preserves the RDMA offer when the server has no devices', async (t) => {
  await using server = await endpoint((command) => {
    if (command === 14) {
      const hello = Buffer.alloc(28)
      hello[0] = 112
      hello.writeUInt32LE(1, 4)
      return hello
    }
    t.is(command, 15)
    return Buffer.alloc(4)
  })
  t.alike(await server.query(), { devices: [], rdmaAvailable: true })
})

test('RPC inventory rejects unsupported versions, invalid lengths and excessive device counts', async (t) => {
  for (const kind of ['version', 'length', 'count', 'memory']) {
    await using server = await endpoint((command) => {
      if (command === 14) {
        const hello = Buffer.alloc(kind === 'length' ? 29 : 28)
        hello[0] = kind === 'version' ? 3 : 112
        return hello
      }
      if (command === 15) {
        const count = Buffer.alloc(4)
        count.writeUInt32LE(kind === 'count' ? 129 : 1)
        return count
      }
      return Buffer.alloc(16, 255)
    })
    t.is(await server.query(), undefined, kind)
  }
})

test('RPC inventory timeout and cancellation close stalled queries', async (t) => {
  using logs = captureWarnings()
  await using server = await endpoint(() => undefined, { timeoutMs: 100 })
  t.is(await server.query(), undefined)
  const controller = new AbortController()
  const query = server.query(controller.signal)
  controller.abort(undefined)
  await query.then(
    () => t.fail('expected cancellation'),
    (error: unknown) => t.ok(error instanceof InferenceCancelledError)
  )
  t.alike(logs.warnings, [], 'unreachable peers are not reported as protocol mismatches')
})

test('RPC inventory reports and rejects incompatible versions before requesting devices', async (t) => {
  for (const [major, minor] of [
    [4, 0],
    [108, 0],
    [109, 0],
    [110, 0],
    [111, 0],
    [113, 0],
    [112, 1]
  ]) {
    using logs = captureWarnings()
    const commands: number[] = []
    await using server = await endpoint((command) => {
      commands.push(command)
      const hello = Buffer.alloc(28)
      hello[0] = major!
      hello[1] = minor!
      hello[2] = 7
      return hello
    })
    t.is(await server.query(), undefined)
    t.alike(commands, [14], 'no inventory requests follow an incompatible HELLO')
    t.is(logs.warnings.length, 1)
    t.ok(logs.warnings[0]?.startsWith('RPC inventory HELLO rejected '))
    const details = JSON.parse(logs.warnings[0]!.slice(logs.warnings[0]!.indexOf('{')))
    t.alike(details, {
      url: server.url,
      reason: 'unsupported protocol version',
      receivedVersion: `${major}.${minor}.7`,
      supportedVersions: '112.0.x',
      receivedHelloBytes: '28',
      expectedHelloBytes: 28
    })
  }
})

test('RPC inventory warns for short and oversized HELLO frames before parsing inventory', async (t) => {
  for (const length of [0, 2, 27, 29, 65536]) {
    for (const splitAt of [[], [3, 8], [3, 10]]) {
      using logs = captureWarnings()
      await using server = await endpoint(
        () => {
          const hello = Buffer.alloc(length)
          if (length >= 3) hello[0] = 112
          return hello
        },
        { splitAt }
      )
      t.is(await server.query(), undefined)
      t.is(logs.warnings.length, 1, `one warning for ${length} bytes split at ${splitAt}`)
      const details = JSON.parse(logs.warnings[0]!.slice(logs.warnings[0]!.indexOf('{')))
      t.is(details.url, server.url)
      t.is(details.receivedHelloBytes, String(length))
      t.is(details.expectedHelloBytes, 28)
      t.is(details.supportedVersions, '112.0.x')
      t.is(details.receivedVersion, splitAt.length === 0 && length >= 3 ? '112.0.0' : 'unavailable')
      t.is(
        details.reason,
        splitAt.length === 0 && length > 28
          ? 'response exceeds frame limit'
          : 'unexpected response size'
      )
    }
  }
})

test('RPC inventory bounds diagnostics for a huge declared length and excess trailing bytes', async (t) => {
  for (const kind of ['header-only', 'trailing']) {
    using logs = captureWarnings()
    await using server = await endpoint(
      () => {
        const hello = Buffer.alloc(28)
        hello[0] = 112
        return hello
      },
      {
        splitAt: [],
        transformFrame(frame) {
          if (kind === 'header-only') {
            const header = Buffer.alloc(8)
            header.writeBigUInt64LE(0xffffffffffffffffn)
            return header
          }
          return Buffer.concat([frame, Buffer.alloc(65536)])
        }
      }
    )
    t.is(await server.query(), undefined)
    t.is(logs.warnings.length, 1)
    const details = JSON.parse(logs.warnings[0]!.slice(logs.warnings[0]!.indexOf('{')))
    t.is(details.receivedHelloBytes, kind === 'header-only' ? '18446744073709551615' : '28')
    t.is(details.receivedVersion, kind === 'header-only' ? 'unavailable' : '112.0.0')
    t.is(
      details.reason,
      kind === 'header-only' ? 'unexpected response size' : 'response exceeds frame limit'
    )
  }
})

function delayedCloseSockets(
  mode: 'success' | 'timeout' | 'cancel' | 'error' | 'connect-throw' | 'dispose'
) {
  const original = Object.getOwnPropertyDescriptor(net, 'Socket')!
  const sockets: Socket[] = []
  let active = 0,
    maximum = 0
  const later = (work: () => void) => {
    void Promise.resolve().then(work)
  }
  class Socket extends EventEmitter {
    destroyed = false
    closed = false
    constructor() {
      super()
      sockets.push(this)
      active++
      maximum = Math.max(maximum, active)
    }
    connect() {
      if (mode === 'connect-throw') throw new Error('connection rejected')
      later(() =>
        mode === 'error' ? this.emit('error', new Error('connection failed')) : this.emit('connect')
      )
    }
    write(request: Buffer) {
      if (mode !== 'success') return true
      const command = request[0]
      const payload = Buffer.alloc(command === 14 ? 28 : command === 15 ? 4 : 16)
      if (command === 14) payload[0] = 112
      else if (command === 15) payload.writeUInt32LE(1)
      else {
        payload.writeBigUInt64LE(1024n, 0)
        payload.writeBigUInt64LE(2048n, 8)
      }
      const header = Buffer.alloc(8)
      header.writeBigUInt64LE(BigInt(payload.length))
      later(() => this.emit('data', Buffer.concat([header, payload])))
      return true
    }
    destroy() {
      this.destroyed = true
    }
    finishClose() {
      if (this.closed) return
      this.closed = true
      active--
      this.emit('close')
    }
  }
  Object.defineProperty(net, 'Socket', { ...original, value: Socket })
  return {
    sockets,
    get maximum() {
      return maximum
    },
    get active() {
      return active
    },
    [Symbol.dispose]() {
      for (const socket of sockets) socket.finishClose()
      Object.defineProperty(net, 'Socket', original)
    }
  }
}

test('RPC inventory completion and scope disposal wait for delayed socket close on every exit', async (t) => {
  for (const mode of [
    'success',
    'timeout',
    'cancel',
    'error',
    'connect-throw',
    'dispose'
  ] as const) {
    using sockets = delayedCloseSockets(mode)
    const scope = createDisposableScope()
    const controller = new AbortController()
    let settled = false,
      disposed = false
    const outcome = queryRpcInventory(
      '10.0.0.2',
      50052,
      mode === 'timeout' ? 5 : 1000,
      controller.signal,
      scope
    ).then(
      (value) => {
        settled = true
        return { value }
      },
      (error: unknown) => {
        settled = true
        return { error }
      }
    )
    if (mode === 'cancel') controller.abort(undefined)
    await new Promise<void>((resolve) => setTimeout(resolve, 15))
    const stopping = scope[Symbol.asyncDispose]().then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    t.ok(sockets.sockets[0]!.destroyed, `${mode} starts socket shutdown`)
    t.absent(settled, `${mode} retains the probe until close completes`)
    t.absent(disposed, `${mode} retains scope cleanup until close completes`)
    sockets.sockets[0]!.finishClose()
    const result = await outcome
    await stopping
    if (mode === 'cancel') {
      t.ok('error' in result && result.error instanceof InferenceCancelledError)
    } else {
      t.alike(result, {
        value: mode === 'success' ? { devices: [device], rdmaAvailable: false } : undefined
      })
    }
    t.is(sockets.active, 0)
  }
})

test('RPC discovery keeps real inventory probes within four sockets until close finishes', async (t) => {
  using sockets = delayedCloseSockets('error')
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({
    requestId: 'inventory-close-bound',
    kind: 'rpcDiscovery'
  })
  let options: Parameters<typeof createLanDiscovery>[0]
  const result = discoverRpcEndpoints('close-bound', 150, ctx, {
    createTransport: (opts) => {
      options = opts
      return {
        suspended: false,
        start: () => Promise.resolve(),
        send: () => Promise.resolve(),
        suspend: () => Promise.resolve(),
        resume: () => Promise.resolve(),
        close() {
          options.onstop?.()
          return Promise.resolve()
        }
      }
    }
  })
  const frame = Buffer.alloc(55)
  frame.write('QVRP')
  frame[4] = 1
  rpcTopic('close-bound').copy(frame, 5)
  frame.writeUInt16BE(50052, 53)
  for (let host = 1; host <= 12; host++) options!.onmessage?.(frame, `10.0.0.${host}`)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  t.is(sockets.sockets.length, 4, 'closing sockets retain all four scheduler slots')
  for (let batch = 0; batch < 3; batch++) {
    for (const socket of sockets.sockets.filter((socket) => !socket.closed)) socket.finishClose()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  t.alike(await result, [])
  t.is(sockets.sockets.length, 12)
  t.is(sockets.maximum, 4)
  t.is(sockets.active, 0)
})
