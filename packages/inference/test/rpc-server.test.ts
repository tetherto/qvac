import test from 'brittle'
import { createRpcServerManager, type RpcServerDependencies } from '@/rpc/manager'
import { createRequestRegistry } from '@/runtime/request-context'
import { privateEndpoint, rpcTopic, probeTcp, waitForReady } from '@/rpc/network'
import {
  startRpcServerOptionsSchema,
  discoverRpcServersOptionsSchema,
  requestSchema,
  responseSchema
} from '@/schemas/index'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { llmConfigSchema } from '@/schemas/llamacpp-config'
import net from 'bare-net'
import type { StartRpcServerOptions } from '@/schemas/rpc-server'

function fixture(overrides: Partial<RpcServerDependencies> = {}) {
  const events: string[] = []
  let count = 0
  const manager = createRpcServerManager({
    async start() {
      const port = 50052 + count++
      events.push(`start:${port}`)
      return {
        host: '10.0.0.2',
        port,
        url: `10.0.0.2:${port}`,
        rdmaCapable: false,
        async stop() {
          events.push(`stop:${port}`)
        }
      }
    },
    async ready() {
      events.push('ready')
    },
    async advertise() {
      events.push('advertise')
      return async () => {
        events.push('withdraw')
      }
    },
    ...overrides
  })
  return { manager, events, registry: createRequestRegistry() }
}
const serving = { host: '10.0.0.2', allowNonLoopbackHost: true, discoveryTopic: 'test' }

test('RPC config preserves endpoint, device and split-weight order', (t) => {
  const input = {
    'rpc-servers': '10.0.0.3:50052,10.0.0.2:50052',
    devices: 'RPC1,RPC0',
    'tensor-split': '3,1',
    'split-mode': 'layer'
  }
  const output = transformLlmConfig(llmConfigSchema.parse(input))
  for (const [key, value] of Object.entries(input)) t.is(output[key], value)
  t.absent(
    'rpc-servers' in transformLlmConfig(llmConfigSchema.parse({})),
    'local config stays local'
  )
})

test('RPC request schemas and bounded discovery', (t) => {
  t.alike(startRpcServerOptionsSchema.parse({}), {}, 'native loopback default preserved')
  t.absent(startRpcServerOptionsSchema.safeParse({ port: 0 }).success)
  t.absent(discoverRpcServersOptionsSchema.safeParse({ topic: ' ', timeoutMs: 100 }).success)
  t.absent(discoverRpcServersOptionsSchema.safeParse({ topic: 'test', timeoutMs: 30001 }).success)
  t.ok(requestSchema.safeParse({ type: 'startRpcServer' }).success)
  t.ok(requestSchema.safeParse({ type: 'stopRpcServer', serverId: 'owned' }).success)
  t.ok(
    responseSchema.safeParse({
      type: 'startRpcServer',
      serverId: 'owned',
      url: '127.0.0.1:1234',
      rdmaCapable: false
    }).success
  )
})

test('RPC discovery responses preserve and require endpoint RDMA availability', (t) => {
  const candidate = {
    url: '10.0.0.2:50052',
    devices: [{ index: 0, freeMemory: 1024, totalMemory: 2048 }]
  }
  for (const rdmaAvailable of [false, true]) {
    const response = { type: 'discoverRpcServers', servers: [{ ...candidate, rdmaAvailable }] }
    t.alike(responseSchema.parse(response), response)
  }
  for (const rdmaAvailable of [undefined, null, 'true']) {
    t.absent(
      responseSchema.safeParse({
        type: 'discoverRpcServers',
        servers: [{ ...candidate, rdmaAvailable }]
      }).success
    )
  }
})

test('RPC endpoints accept only private IPv4 and use a shared topic hash', (t) => {
  for (const url of ['10.0.0.2:1', '172.16.0.1:65535', '192.168.1.2:50052']) {
    t.ok(privateEndpoint(url), url)
  }
  for (const url of [
    'localhost:1',
    '127.0.0.1:1',
    '0.0.0.0:1',
    '8.8.8.8:1',
    '169.254.0.1:1',
    '172.32.0.1:1',
    '10.0.0.999:1',
    '10.0.0.2:0',
    '10.0.0.2:65536',
    '010.0.0.2:1',
    '[::1]:1'
  ]) {
    t.absent(privateEndpoint(url), url)
  }
  t.is(rpcTopic('test').length, 32)
  t.alike(rpcTopic('test'), rpcTopic('test'))
  t.unlike(rpcTopic('test'), rpcTopic('other'))
})

test('RPC manager advertises after readiness, owns multiple IDs and withdraws before stop', async (t) => {
  const { manager, events, registry } = fixture()
  await using ctx = await registry.begin({ requestId: 'start', kind: 'rpcServer' })
  const first = await manager.start(serving, ctx)
  const second = await manager.start(serving, ctx)
  t.not(first.serverId, second.serverId)
  t.absent('runtime' in first, 'managed server response omits runtime')
  t.alike(events.slice(0, 3), ['start:50052', 'ready', 'advertise'])
  await manager.stop(first.serverId)
  t.alike(events.slice(-2), ['withdraw', 'stop:50052'])
  t.is(manager.size, 1)
  await manager.close()
  t.is(manager.size, 0)
})

test('RPC manager rejects unsafe advertising before starting native resources', async (t) => {
  const { manager, events, registry } = fixture()
  await using ctx = await registry.begin({ requestId: 'unsafe', kind: 'rpcServer' })
  for (const options of [
    { discoveryTopic: 'test' },
    { ...serving, host: '0.0.0.0' },
    { ...serving, allowNonLoopbackHost: false }
  ]) {
    await t.exception(manager.start(options, ctx), /private IPv4/)
  }
  t.alike(events, [])
})

const lan = { name: 'en0', address: '10.0.0.2', netmask: '255.255.255.0' }

test('RPC advertising automatically selects a single eligible LAN address before native startup', async (t) => {
  const forwarded: StartRpcServerOptions[] = []
  const { manager, registry } = fixture({
    lanInterfaces: () => [lan],
    async start(options) {
      forwarded.push(options)
      return {
        host: options.host!,
        port: 50052,
        url: `${options.host}:50052`,
        rdmaCapable: false,
        async stop() {}
      }
    }
  })
  await using ctx = await registry.begin({ requestId: 'auto-host', kind: 'rpcServer' })
  const options = { discoveryTopic: 'test', allowNonLoopbackHost: true, threads: 2 }
  try {
    const server = await manager.start(options, ctx)
    t.is(server.url, '10.0.0.2:50052')
    t.alike(forwarded, [{ ...options, host: lan.address }])
    t.absent('host' in options, 'caller options remain unchanged')
  } finally {
    await manager.close()
  }
})

test('RPC automatic binding rejects missing or ambiguous addresses before starting native resources', async (t) => {
  for (const interfaces of [
    [],
    [lan, { ...lan, name: 'eth0', address: '10.0.1.2' }],
    [lan, { ...lan, address: '10.0.0.3' }]
  ]) {
    const { manager, events, registry } = fixture({ lanInterfaces: () => interfaces })
    await using ctx = await registry.begin({ requestId: 'auto-invalid', kind: 'rpcServer' })
    await t.exception(
      manager.start({ discoveryTopic: 'test', allowNonLoopbackHost: true }, ctx),
      interfaces.length
        ? /Multiple eligible RPC LAN addresses; specify host explicitly/
        : /eligible private IPv4/
    )
    t.alike(events, [], 'selection fails before native startup')
    t.is(manager.size, 0)
  }
})

test('RPC explicit hosts and non-advertising defaults bypass automatic LAN selection', async (t) => {
  let scans = 0
  const forwarded: StartRpcServerOptions[] = []
  const { manager, registry } = fixture({
    lanInterfaces: () => {
      scans++
      throw new Error('must not enumerate interfaces')
    },
    async start(options) {
      forwarded.push(options)
      const host = options.host ?? '127.0.0.1'
      return { host, port: 50052, url: `${host}:50052`, rdmaCapable: false, async stop() {} }
    }
  })
  await using ctx = await registry.begin({ requestId: 'explicit-host', kind: 'rpcServer' })
  try {
    for (const options of [{}, { allowNonLoopbackHost: true }, { host: '127.0.0.1' }, serving]) {
      const server = await manager.start(options, ctx)
      t.is(server.url, `${'host' in options ? options.host : '127.0.0.1'}:50052`)
      t.alike(forwarded.at(-1), options)
    }
    for (const options of [
      { discoveryTopic: 'test' },
      { discoveryTopic: 'test', allowNonLoopbackHost: false }
    ]) {
      await t.exception(manager.start(options, ctx), /allowNonLoopbackHost: true/)
    }
    t.is(scans, 0)
  } finally {
    await manager.close()
  }
})

test('RPC failed readiness stops the native handle without advertising', async (t) => {
  const { manager, events, registry } = fixture({
    async ready() {
      throw new Error('not ready')
    }
  })
  await using ctx = await registry.begin({ requestId: 'failed', kind: 'rpcServer' })
  await t.exception(manager.start(serving, ctx), /not ready/)
  t.alike(events, ['start:50052', 'stop:50052'])
  t.is(manager.size, 0)
})

test('RPC failed advertising and cancelled start clean up native resources', async (t) => {
  const { manager, events, registry } = fixture({
    async advertise() {
      throw new Error('join failed')
    }
  })
  await using ctx = await registry.begin({ requestId: 'advertise', kind: 'rpcServer' })
  await t.exception(manager.start(serving, ctx), /join failed/)
  t.is(manager.size, 0)
  t.is(events.at(-1), 'stop:50052')
  registry.cancel({ requestId: 'advertise' })
  await t.exception(manager.start(serving, ctx))
  t.is(events.length, 3, 'cancelled request cannot create another server')
})

test('RPC failed stop retains ownership, close attempts every server, retry succeeds', async (t) => {
  let fail = true
  const stopped: number[] = []
  let n = 0
  const { manager, registry } = fixture({
    async start() {
      const id = n++
      return {
        host: '127.0.0.1',
        port: id + 1000,
        url: `127.0.0.1:${id + 1000}`,
        rdmaCapable: false,
        async stop() {
          stopped.push(id)
          if (fail && id === 0) throw new Error('native stop failed')
        }
      }
    }
  })
  await using ctx = await registry.begin({ requestId: 'stop', kind: 'rpcServer' })
  await manager.start({}, ctx)
  await manager.start({}, ctx)
  await t.exception(manager.close(), /Failed to stop owned/)
  t.alike(stopped, [0, 1])
  t.is(manager.size, 1)
  fail = false
  await manager.close()
  t.is(manager.size, 0)
})

test('RPC stalled stop stays pending and shutdown still attempts other servers', async (t) => {
  let finish!: () => void
  let n = 0
  const stopped: number[] = []
  const { manager, registry } = fixture({
    async start() {
      const id = n++
      return {
        host: '127.0.0.1',
        port: id + 1000,
        url: `127.0.0.1:${id + 1000}`,
        rdmaCapable: false,
        async stop() {
          stopped.push(id)
          if (id === 0) {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
          }
        }
      }
    }
  })
  await using ctx = await registry.begin({ requestId: 'stall', kind: 'rpcServer' })
  await manager.start({}, ctx)
  await manager.start({}, ctx)
  let closed = false
  const closing = manager.close().then(() => {
    closed = true
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  t.alike(stopped, [0, 1])
  t.absent(closed)
  t.is(manager.size, 1)
  finish()
  await closing
  t.is(manager.size, 0)
})

test('RPC probes release TCP sockets and readiness sees a real listener', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'probe', kind: 'rpcServer' })
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.resume()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  try {
    t.ok(await probeTcp('127.0.0.1', address.port, 100, ctx.signal))
    await waitForReady('127.0.0.1', address.port, ctx.signal)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  t.absent(await probeTcp('127.0.0.1', address.port, 100, ctx.signal))
})

test('RPC failed rollback retains its native handle for shutdown retry', async (t) => {
  let fail = true
  const { manager, registry } = fixture({
    async start() {
      return {
        host: '127.0.0.1',
        port: 1000,
        url: '127.0.0.1:1000',
        rdmaCapable: false,
        async stop() {
          if (fail) throw new Error('cannot stop yet')
        }
      }
    },
    async ready() {
      throw new Error('not ready')
    }
  })
  await using ctx = await registry.begin({ requestId: 'rollback', kind: 'rpcServer' })
  await t.exception(manager.start({}, ctx))
  t.is(manager.size, 1)
  fail = false
  await manager.close()
  t.is(manager.size, 0)
})

test('RPC close racing a start disposes its handle instead of returning a live server', async (t) => {
  let ready!: () => void
  const { manager, events, registry } = fixture({
    async ready() {
      await new Promise<void>((resolve) => {
        ready = resolve
      })
    }
  })
  await using ctx = await registry.begin({ requestId: 'racing', kind: 'rpcServer' })
  const starting = manager.start({}, ctx)
  const rejection = t.exception(starting, /closing/)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const closing = manager.close()
  ready()
  await rejection
  await closing
  t.is(manager.size, 0)
  t.is(events.at(-1), 'stop:50052')
})

test('RPC rollback stalled in native stop does not prevent stopping other owned servers', async (t) => {
  let finish!: () => void
  let n = 0
  const stops: number[] = []
  const { manager, registry } = fixture({
    async start() {
      const port = 1000 + n++
      return {
        host: '127.0.0.1',
        port,
        url: `127.0.0.1:${port}`,
        rdmaCapable: false,
        async stop() {
          stops.push(port)
          if (port === 1001) {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
          }
        }
      }
    },
    async ready(server) {
      if (server.port === 1001) throw new Error('readiness failed')
    }
  })
  await using ctx = await registry.begin({ requestId: 'rollback-stalled', kind: 'rpcServer' })
  await manager.start({}, ctx)
  const failedStart = t.exception(manager.start({}, ctx), /readiness failed/)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const closing = manager.close()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  t.ok(stops.includes(1000), 'other native stop begins while rollback is pending')
  finish()
  await failedStart
  await closing
  t.is(manager.size, 0)
})
