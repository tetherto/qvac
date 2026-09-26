import test from 'brittle'
import net from 'bare-net'
import { Buffer } from 'bare-buffer'
import { AbortController } from 'bare-abort-controller'
import { queryRpcDevices } from '@/rpc/inventory'
import { getRpcDeviceMap } from '@/rpc/device-map'
import { InferenceCancelledError } from '@/errors/index'

async function endpoint(reply: (command: number, payload: Buffer) => Buffer | undefined) {
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
      socket.write(header.subarray(0, 3))
      socket.write(Buffer.concat([Buffer.from(header.subarray(3)), response]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  return {
    query: (signal = new AbortController().signal) =>
      queryRpcDevices('127.0.0.1', address.port, 100, signal),
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const device = { index: 0, freeMemory: 1024, totalMemory: 2048 }
const first = { url: '10.0.0.2:50052', devices: [device, { ...device, index: 1 }] }
const second = { url: '10.0.0.3:50052', devices: [device] }

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
    'native endpoint registration deduplicates'
  )
  t.is(getRpcDeviceMap([second, first])[1]!.url, first.url)
  t.is(getRpcDeviceMap([second, first])[1]!.alias, 'RPC1')
  t.alike(getRpcDeviceMap([]), [])
  t.exception(
    () => getRpcDeviceMap([{ ...first, devices: [{ ...device, index: 1 }] }]),
    /native device order/
  )
})

test('RPC inventory reads native device count and memory over fragmented TCP responses', async (t) => {
  const commands: number[] = []
  await using server = await endpoint((command, payload) => {
    commands.push(command)
    if (command === 14) {
      t.alike(payload, Buffer.alloc(24), 'TCP-only capabilities')
      const hello = Buffer.alloc(28)
      hello[0] = 108
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
  t.alike(await server.query(), [device, { ...device, index: 1, freeMemory: 1025 }])
  t.alike(commands, [14, 15, 11, 11])
})

test('RPC inventory rejects unsupported versions, invalid lengths and excessive device counts', async (t) => {
  for (const kind of ['version', 'length', 'count', 'memory']) {
    await using server = await endpoint((command) => {
      if (command === 14) {
        const hello = Buffer.alloc(kind === 'length' ? 29 : 28)
        hello[0] = kind === 'version' ? 3 : 109
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
  await using server = await endpoint(() => undefined)
  t.is(await server.query(), undefined)
  const controller = new AbortController()
  const query = server.query(controller.signal)
  controller.abort(undefined)
  await query.then(
    () => t.fail('expected cancellation'),
    (error: unknown) => t.ok(error instanceof InferenceCancelledError)
  )
})
