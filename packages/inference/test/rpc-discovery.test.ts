import test from 'brittle'
import { Buffer } from 'bare-buffer'
import { advertiseRpcServer, discoverRpcEndpoints, parseAnnouncement } from '@/rpc/discovery'
import { rpcTopic } from '@/rpc/network'
import { ANNOUNCEMENT_BYTES, type LanDiscovery, createLanDiscovery } from '@/rpc/lan'
import { getRpcDeviceMap } from '@/rpc/device-map'
import { createRequestRegistry } from '@/runtime/request-context'
import {
  registerSwarm,
  unregisterSwarm,
  getRegisteredResourceCounts,
  resumeRuntime,
  suspendRuntime,
  resetLifecycleState
} from '@/runtime/runtime-lifecycle'

const devices = [{ index: 0, freeMemory: 1024, totalMemory: 2048 }]
const inventory = { devices, rdmaAvailable: false }
function frame(topic = 'shared', port = 50052, id = 1) {
  const value = Buffer.alloc(ANNOUNCEMENT_BYTES)
  value.fill(id)
  value.write('QVRP', 0, 'ascii')
  value[4] = 1
  rpcTopic(topic).copy(value, 5)
  value.writeUInt16BE(port, 53)
  return value
}
function fakeTransport() {
  let options: Parameters<typeof createLanDiscovery>[0]
  let closed = false
  const sent: Buffer[] = []
  let suspended = false
  const resource: LanDiscovery = {
    get suspended() {
      return suspended
    },
    async start() {},
    async send(packet) {
      if (!resource.suspended) sent.push(packet)
    },
    async suspend() {
      suspended = true
      options.onstop?.()
    },
    async resume() {
      suspended = false
    },
    async close() {
      closed = true
      await resource.suspend()
      unregisterSwarm(resource)
    }
  }
  return {
    resource,
    sent,
    get closed() {
      return closed
    },
    factory: ((opts) => {
      options = opts
      registerSwarm(resource, { label: 'rpc-test', createdAt: Date.now() })
      return resource
    }) as typeof createLanDiscovery,
    announce(host: string, packet = frame()) {
      options.onmessage?.(packet, host)
    },
    fail(error: Error) {
      options.onstop?.(error)
    }
  }
}

test('RPC datagrams require exact size, protocol, topic and nonzero port', (t) => {
  const packet = frame()
  t.alike(parseAnnouncement(packet, rpcTopic('shared')), { port: 50052, instance: '01'.repeat(16) })
  t.absent(parseAnnouncement(packet, rpcTopic('other')))
  for (const invalid of [
    Buffer.alloc(10000),
    Buffer.from(packet.subarray(0, 20)),
    Buffer.concat([packet, packet]),
    Buffer.from('{bad}')
  ]) {
    t.absent(parseAnnouncement(invalid, rpcTopic('shared')))
  }
  packet[4] = 2
  t.absent(parseAnnouncement(packet, rpcTopic('shared')))
  packet[4] = 1
  packet.writeUInt16BE(0, 53)
  t.absent(parseAnnouncement(packet, rpcTopic('shared')))
})

test('RPC lookup deduplicates, excludes unreachable endpoints, isolates topics and cleans up', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'lookup', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const probed: string[] = []
  const result = discoverRpcEndpoints('shared', 100, ctx, {
    createTransport: transport.factory,
    probe: async (host) => {
      probed.push(host)
      return host !== '10.0.0.3' ? inventory : undefined
    }
  })
  transport.announce('10.0.0.2')
  transport.announce('10.0.0.2')
  transport.announce('10.0.0.3')
  transport.announce('10.0.0.4', frame('other'))
  t.alike(await result, [{ url: '10.0.0.2:50052', ...inventory }])
  t.alike(probed, ['10.0.0.2', '10.0.0.3'])
  t.ok(transport.closed)
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('RPC stale announcements expire and fragmented datagrams never form a frame', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'stale', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  let probes = 0
  const result = discoverRpcEndpoints('shared', 3100, ctx, {
    createTransport: transport.factory,
    probe: async () => {
      probes++
      return inventory
    }
  })
  transport.announce('10.0.0.2')
  transport.announce('10.0.0.3', Buffer.from(frame().subarray(0, 20)))
  transport.announce('10.0.0.3', Buffer.from(frame().subarray(20)))
  t.alike(await result, [])
  t.is(probes, 1)
})

test('RPC lookup bounds unique endpoints, concurrent probes and instance churn', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'bounds', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  let active = 0,
    maximum = 0,
    probes = 0
  const result = discoverRpcEndpoints('shared', 400, ctx, {
    createTransport: transport.factory,
    probe: async () => {
      probes++
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(() => resolve(undefined), 5))
      active--
      return inventory
    }
  })
  for (let i = 1; i < 100; i++) transport.announce(`10.0.0.${i}`)
  for (let i = 2; i < 200; i++) transport.announce('10.0.0.1', frame('shared', 50052, i))
  t.is((await result).length, 64)
  t.ok(probes <= 65)
  t.is(maximum, 4)
})

test('RPC lookup cancellation and transport errors close pending probes and discovery', async (t) => {
  for (const failure of [false, true]) {
    const registry = createRequestRegistry()
    await using ctx = await registry.begin({ requestId: 'cancel', kind: 'rpcDiscovery' })
    const transport = fakeTransport()
    let aborted = false
    const result = discoverRpcEndpoints('shared', 30000, ctx, {
      createTransport: transport.factory,
      probe: async (_host, _port, _timeout, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve(undefined)
            },
            { once: true }
          )
        })
    })
    transport.announce('10.0.0.2')
    if (failure) transport.fail(new Error('UDP failed'))
    else registry.cancel({ requestId: 'cancel' })
    await t.exception(result)
    t.ok(aborted)
    t.ok(transport.closed)
    t.is(getRegisteredResourceCounts().swarms, 0)
  }
})

test('RPC advertisers suspend, resume and stop without keeping announcement timers alive', async (t) => {
  resetLifecycleState()
  const transport = fakeTransport()
  const withdraw = await advertiseRpcServer(
    'shared',
    '10.0.0.2:50052',
    undefined,
    transport.factory
  )
  t.ok(parseAnnouncement(transport.sent[0], rpcTopic('shared')))
  await suspendRuntime()
  t.ok(transport.resource.suspended)
  await resumeRuntime()
  t.absent(transport.resource.suspended)
  await withdraw()
  await withdraw()
  t.ok(transport.closed)
  t.is(getRegisteredResourceCounts().swarms, 0)
  resetLifecycleState()
})

test('RPC suspend invalidates inventories and ignores probes completing after resume', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'resume', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  let finish: (value: typeof inventory) => void = () => {}
  const result = discoverRpcEndpoints('shared', 100, ctx, {
    createTransport: transport.factory,
    probe: () =>
      new Promise((resolve) => {
        finish = resolve
      })
  })
  transport.announce('10.0.0.2')
  await transport.resource.suspend()
  await transport.resource.resume()
  finish(inventory)
  t.alike(await result, [])
})

test('RPC discovery preserves complete multi-device inventories and mapping', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'inventory', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const result = discoverRpcEndpoints('shared', 100, ctx, {
    createTransport: transport.factory,
    probe: async (host) =>
      host === '10.0.0.2'
        ? { devices: [devices[0], { ...devices[0], index: 1 }], rdmaAvailable: true }
        : host === '10.0.0.3'
          ? inventory
          : { devices: [], rdmaAvailable: true }
  })
  for (const host of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) transport.announce(host)
  const candidates = await result
  t.alike(
    candidates.map(({ rdmaAvailable }) => rdmaAvailable),
    [true, false]
  )
  t.alike(
    getRpcDeviceMap(candidates).map(({ alias, url, index }) => ({ alias, url, index })),
    [
      { alias: 'RPC0', url: '10.0.0.2:50052', index: 0 },
      { alias: 'RPC1', url: '10.0.0.2:50052', index: 1 },
      { alias: 'RPC2', url: '10.0.0.3:50052', index: 0 }
    ]
  )
})

test('RPC advertising startup reports send failure and closes the transport', async (t) => {
  const transport = fakeTransport()
  transport.resource.send = async () => {
    throw new Error('EPERM')
  }
  await t.exception(advertiseRpcServer('shared', '10.0.0.2:50052', undefined, transport.factory))
  t.ok(transport.closed)
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('RPC later announcements retry a failed inventory probe within the lookup budget', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'retry', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  let probes = 0
  const result = discoverRpcEndpoints('shared', 1200, ctx, {
    createTransport: transport.factory,
    probe: async () => (++probes === 1 ? undefined : inventory)
  })
  transport.announce('10.0.0.2')
  await new Promise<void>((resolve) => setTimeout(resolve, 900))
  transport.announce('10.0.0.2')
  t.alike(await result, [{ url: '10.0.0.2:50052', ...inventory }])
  t.is(probes, 2)
})
