import test from 'brittle'
import { Buffer } from 'bare-buffer'
import EventEmitter from 'bare-events'
import type { createSocket } from 'bare-dgram'
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
    async start() {
      options.onstart?.()
    },
    async send(packet) {
      if (!resource.suspended) sent.push(packet)
    },
    async suspend() {
      suspended = true
      options.onstop?.()
    },
    async resume() {
      suspended = false
      options.onstart?.()
    },
    async close() {
      closed = true
      await resource.suspend()
      unregisterSwarm(resource)
    }
  }
  return {
    resource,
    get options() {
      return options
    },
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
  const result = discoverRpcEndpoints('shared', 650, ctx, {
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

test('RPC advertiser forwards active, suspended and failed state with the original error', async (t) => {
  const transport = fakeTransport()
  const states: Array<{ state: string; error?: Error }> = []
  const withdraw = await advertiseRpcServer(
    'shared',
    '10.0.0.2:50052',
    undefined,
    transport.factory,
    (state, error) => states.push({ state, ...(error && { error }) })
  )
  try {
    t.is(states[0]?.state, 'advertising')
    await transport.resource.suspend()
    t.is(states.at(-1)?.state, 'suspended')
    await transport.resource.resume()
    t.is(states.at(-1)?.state, 'advertising')
    const cause = new Error('send failed')
    transport.fail(cause)
    t.is(states.at(-1)?.state, 'failed')
    t.is(states.at(-1)?.error, cause)
  } finally {
    await withdraw()
  }
})

test('RPC sessions reset endpoint attempts and reject inventories from before suspension', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'session-accounting', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const counts = new Map<string, number>()
  let finishOld: (value: typeof inventory) => void = () => {}
  const result = discoverRpcEndpoints('shared', 900, ctx, {
    createTransport: transport.factory,
    probe: async (host) => {
      const count = (counts.get(host) ?? 0) + 1
      counts.set(host, count)
      if (host === '10.0.0.3') {
        return count === 1
          ? new Promise((resolve) => {
              finishOld = resolve
            })
          : undefined
      }
      return count === 1 ? undefined : inventory
    }
  })
  transport.announce('10.0.0.2')
  await new Promise<void>((resolve) => setTimeout(resolve, 550))
  t.is(counts.get('10.0.0.2'), 2, 'scheduler retries without another announcement')
  transport.announce('10.0.0.3')
  await transport.resource.suspend()
  await transport.resource.resume()
  transport.announce('10.0.0.2')
  transport.announce('10.0.0.3')
  finishOld(inventory)
  t.alike(await result, [{ url: '10.0.0.2:50052', ...inventory }])
  t.is(counts.get('10.0.0.2'), 3, 'fresh session revalidates a previously healthy endpoint')
  t.is(counts.get('10.0.0.3'), 2, 'late inventory cannot populate the resumed candidate')
})

test('RPC one source cannot reserve every candidate or probe slot with bogus ports', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'source-fairness', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const starts: string[] = []
  const result = discoverRpcEndpoints('shared', 200, ctx, {
    createTransport: transport.factory,
    probe: async (host) => {
      starts.push(host)
      return host === '10.0.0.2' ? inventory : undefined
    }
  })
  for (let port = 1; port <= 64; port++) transport.announce('10.0.0.1', frame('shared', port))
  transport.announce('10.0.0.2')
  t.alike(await result, [{ url: '10.0.0.2:50052', ...inventory }])
  t.ok(starts.indexOf('10.0.0.2') <= 4, 'ready sources rotate when a probe slot opens')
  t.ok(starts.filter((host) => host === '10.0.0.1').length <= 8)
})

test('RPC old probes count toward concurrency until their asynchronous cleanup settles', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'probe-cleanup', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const cleanups: Array<() => void> = []
  let starts = 0,
    active = 0,
    maximum = 0
  const result = discoverRpcEndpoints('shared', 250, ctx, {
    createTransport: transport.factory,
    probe: async (_host, _port, _timeout, _signal, scope) => {
      starts++
      active++
      maximum = Math.max(maximum, active)
      const old = starts <= 4
      scope?.defer(async () => {
        if (old) await new Promise<void>((resolve) => cleanups.push(resolve))
        active--
      })
      return inventory
    }
  })
  for (let i = 1; i <= 4; i++) transport.announce(`10.0.0.${i}`)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  t.is(cleanups.length, 4)
  await transport.resource.suspend()
  await transport.resource.resume()
  for (let i = 1; i <= 4; i++) transport.announce(`10.0.0.${i}`)
  t.is(starts, 4, 'resumed work waits for old sockets to close')
  cleanups[0]!()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  t.ok(starts > 4)
  for (const finish of cleanups.slice(1)) finish()
  t.is((await result).length, 4)
  t.is(maximum, 4)
  t.is(active, 0)
})

test('RPC lifetime source and lookup probe budgets survive repeated suspension and instance churn', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'lifetime-bounds', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const counts = new Map<string, number>()
  let starts = 0
  const result = discoverRpcEndpoints('shared', 350, ctx, {
    createTransport: transport.factory,
    probe: async (host) => {
      starts++
      counts.set(host, (counts.get(host) ?? 0) + 1)
      return undefined
    }
  })
  for (let session = 1; session <= 20; session++) {
    for (let host = 1; host <= 10; host++) {
      for (let port = 1; port <= 20; port++) {
        transport.announce(`10.0.0.${host}`, frame('shared', port, session))
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await transport.resource.suspend()
    await transport.resource.resume()
  }
  t.alike(await result, [])
  t.is(starts, 128, 'lookup work stops at its original total allowance')
  for (const count of counts.values()) {
    t.ok(count <= 16, 'one source cannot consume the lookup budget')
  }
})

test('RPC resident slots expire while endpoint cooldown and attempt limits survive eviction', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'resident-reclaim', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const counts = new Map<number, number>()
  const result = discoverRpcEndpoints('shared', 3900, ctx, {
    createTransport: transport.factory,
    probe: async (_host, port) => {
      counts.set(port, (counts.get(port) ?? 0) + 1)
      return port === 50052 ? inventory : undefined
    }
  })
  for (let port = 1; port <= 8; port++) transport.announce('10.0.0.1', frame('shared', port))
  await new Promise<void>((resolve) => setTimeout(resolve, 550))
  for (let id = 2; id < 100; id++) {
    for (let port = 1; port <= 8; port++) transport.announce('10.0.0.1', frame('shared', port, id))
  }
  transport.announce('10.0.0.2')
  await new Promise<void>((resolve) => setTimeout(resolve, 3100))
  transport.announce('10.0.0.3')
  t.alike(await result, [{ url: '10.0.0.3:50052', ...inventory }])
  for (let port = 1; port <= 8; port++) {
    t.is(counts.get(port), 2, 'instance churn cannot reset attempts')
  }
})

test('RPC expired resident candidates release capacity for a fresh source', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'expired-capacity', kind: 'rpcDiscovery' })
  const transport = fakeTransport()
  const result = discoverRpcEndpoints('shared', 3300, ctx, {
    createTransport: transport.factory,
    probe: async () => inventory
  })
  for (let i = 1; i <= 64; i++) transport.announce(`10.0.0.${i}`)
  await new Promise<void>((resolve) => setTimeout(resolve, 3100))
  transport.announce('10.0.0.65')
  t.alike(await result, [{ url: '10.0.0.65:50052', ...inventory }])
})

test('RPC protocol admission survives irrelevant bursts and source flooding before inventory probes', async (t) => {
  class Receiver extends EventEmitter {
    bind(_port: number, _address: string, done: () => void) {
      done()
    }
    close(done: () => void) {
      this.emit('close')
      done()
    }
    addMembership() {}
  }
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'packet-admission', kind: 'rpcDiscovery' })
  const socket = new Receiver()
  const probes: string[] = []
  const result = discoverRpcEndpoints('shared', 200, ctx, {
    createTransport: (options) =>
      createLanDiscovery(options, {
        interfaces: () => [{ name: 'en0', address: '192.168.1.2', netmask: '255.255.255.0' }],
        socket: (() => socket) as unknown as typeof createSocket
      }),
    probe: async (host, port) => {
      probes.push(`${host}:${port}`)
      return host === '192.168.1.4' ? inventory : undefined
    }
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const packet = (host: string, value: Buffer) =>
    socket.emit('message', value, { address: host, family: 'IPv4' })
  for (let i = 0; i < 256; i++) {
    packet('192.168.1.3', Buffer.alloc(54))
    packet('10.0.0.3', frame())
    packet('192.168.1.3', frame('other'))
  }
  for (let port = 1; port <= 64; port++) packet('192.168.1.3', frame('shared', port))
  packet('192.168.1.4', frame())
  packet('192.168.1.4', frame('shared', 50053))
  t.alike(await result, [
    { url: '192.168.1.4:50052', ...inventory },
    { url: '192.168.1.4:50053', ...inventory }
  ])
  t.ok(probes.filter((url) => url.startsWith('192.168.1.3:')).length <= 8)
  t.ok(probes.includes('192.168.1.4:50052'))
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('RPC explicit LAN selection reaches receiver membership and pins advertising to its bound host', async (t) => {
  const addresses = ['10.0.0.2', '10.0.1.2']
  const advertiser = fakeTransport()
  await t.exception(
    advertiseRpcServer(
      'shared',
      '10.9.0.2:50052',
      undefined,
      advertiser.factory,
      undefined,
      addresses
    ),
    /must belong/
  )
  const withdraw = await advertiseRpcServer(
    'shared',
    '10.0.0.2:50052',
    undefined,
    advertiser.factory,
    undefined,
    addresses
  )
  try {
    t.alike(advertiser.options.lanAddresses, ['10.0.0.2'])
  } finally {
    await withdraw()
  }
  const receiver = fakeTransport()
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'selected-lookup', kind: 'rpcDiscovery' })
  const lookup = discoverRpcEndpoints(
    'shared',
    100,
    ctx,
    { createTransport: receiver.factory, probe: async () => inventory },
    addresses
  )
  t.alike(receiver.options.lanAddresses, addresses)
  receiver.announce('10.0.0.3')
  t.alike(await lookup, [{ url: '10.0.0.3:50052', ...inventory }])
})
