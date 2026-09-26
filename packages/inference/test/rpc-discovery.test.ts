import test from 'brittle'
import { Buffer } from 'bare-buffer'
import Hyperswarm, { type Connection } from 'hyperswarm'
import EventEmitter from 'bare-events'
import { advertiseRpcServer, discoverRpcEndpoints } from '@/rpc/discovery'
import { getRpcDeviceMap } from '@/rpc/device-map'
import { createRequestRegistry } from '@/runtime/request-context'
import {
  getRegisteredResourceCounts,
  registerSwarm,
  resumeRuntime,
  suspendRuntime,
  resetLifecycleState
} from '@/runtime/runtime-lifecycle'

const devices = [{ index: 0, freeMemory: 1024, totalMemory: 2048 }]

class Peer extends EventEmitter {
  destroyed = false
  writes: string[] = []
  write(frame: string) {
    this.writes.push(frame)
    return true
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('close')
    }
  }
  announce(url: string) {
    this.emit('data', Buffer.from(JSON.stringify({ version: 1, url }) + '\n'))
  }
}
class Swarm extends EventEmitter {
  suspended = false
  destroyed = false
  topics: Buffer[] = []
  join(topic: Buffer) {
    this.topics.push(topic)
  }
  async destroy() {
    this.destroyed = true
  }
  async suspend() {
    this.suspended = true
  }
  async resume() {
    this.suspended = false
  }
  connect(peer: Peer) {
    this.emit('connection', peer as unknown as Connection)
  }
}
function fakeSwarm() {
  const swarm = new Swarm()
  const factory = () => {
    registerSwarm(swarm, { label: 'rpc-test', createdAt: Date.now() })
    return swarm as unknown as Hyperswarm
  }
  return { swarm, factory }
}

test('RPC lookup deduplicates, rejects unreachable endpoints, uses shared hashed topic, and cleans resources', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'lookup', kind: 'rpcDiscovery' })
  const { swarm, factory } = fakeSwarm()
  const probed: string[] = []
  const result = discoverRpcEndpoints('shared', 100, ctx, {
    createSwarm: factory,
    probe: async (host) => {
      probed.push(host)
      return host !== '10.0.0.3' ? devices : undefined
    }
  })
  for (const host of ['10.0.0.2', '10.0.0.2', '10.0.0.3']) {
    const peer = new Peer()
    swarm.connect(peer)
    peer.announce(`${host}:50052`)
  }
  const advertiser = fakeSwarm()
  const withdraw = await advertiseRpcServer('shared', '10.0.0.2:50052', advertiser.factory)
  t.alike(swarm.topics, advertiser.swarm.topics)
  t.alike(await result, [{ url: '10.0.0.2:50052', devices }])
  t.alike(probed, ['10.0.0.2', '10.0.0.3'])
  t.ok(swarm.destroyed)
  await withdraw()
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('RPC closed peers withdraw candidates and malformed or oversized peers are disconnected', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'withdraw', kind: 'rpcDiscovery' })
  const { swarm, factory } = fakeSwarm()
  const result = discoverRpcEndpoints('withdraw', 100, ctx, {
    createSwarm: factory,
    probe: async () => devices
  })
  const peer = new Peer()
  swarm.connect(peer)
  peer.announce('10.0.0.2:50052')
  peer.destroy()
  const malformed = new Peer()
  swarm.connect(malformed)
  malformed.emit('data', Buffer.from('{bad}\n'))
  const oversized = new Peer()
  swarm.connect(oversized)
  oversized.emit('data', Buffer.alloc(1025))
  t.ok(malformed.destroyed)
  t.ok(oversized.destroyed)
  t.alike(await result, [])
})

test('RPC fragmented frames are accepted; stale announcements expire', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'stale', kind: 'rpcDiscovery' })
  const { swarm, factory } = fakeSwarm()
  let probes = 0
  const result = discoverRpcEndpoints('stale', 3100, ctx, {
    createSwarm: factory,
    probe: async () => {
      probes++
      return devices
    }
  })
  const peer = new Peer()
  swarm.connect(peer)
  peer.emit('data', Buffer.from('{"version":1,"url":"10.0.'))
  peer.emit('data', Buffer.from('0.2:50052"}\n'))
  t.alike(await result, [])
  t.is(probes, 1)
})

test('RPC lookup cancellation destroys the swarm and disconnects peers', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'cancel-lookup', kind: 'rpcDiscovery' })
  const { swarm, factory } = fakeSwarm()
  const result = discoverRpcEndpoints('cancel', 30000, ctx, { createSwarm: factory })
  const peer = new Peer()
  swarm.connect(peer)
  registry.cancel({ requestId: 'cancel-lookup' })
  await t.exception(result)
  t.ok(swarm.destroyed)
  t.ok(peer.destroyed)
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('RPC advertisers participate in runtime suspend/resume and withdraw connections on stop', async (t) => {
  resetLifecycleState()
  const { swarm, factory } = fakeSwarm()
  const withdraw = await advertiseRpcServer('shared', '10.0.0.2:50052', factory)
  const peer = new Peer()
  swarm.connect(peer)
  t.is(peer.writes.length, 1)
  await suspendRuntime()
  t.ok(swarm.suspended)
  await resumeRuntime()
  t.absent(swarm.suspended)
  await withdraw()
  t.ok(peer.destroyed)
  t.ok(swarm.destroyed)
  t.is(getRegisteredResourceCounts().swarms, 0)
  resetLifecycleState()
})

test('RPC real Hyperswarm lookup with no matching peers returns within its budget and cleans up', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'empty-real', kind: 'rpcDiscovery' })
  const started = Date.now()
  const result = await discoverRpcEndpoints(`empty-${Date.now()}-${Math.random()}`, 100, ctx)
  t.alike(result, [])
  t.ok(Date.now() - started < 2000, 'lookup does not wait for DHT bootstrap')
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('RPC discovery returns complete inventories before mapping multi-device endpoints', async (t) => {
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'inventory', kind: 'rpcDiscovery' })
  const { swarm, factory } = fakeSwarm()
  const result = discoverRpcEndpoints('inventory', 100, ctx, {
    createSwarm: factory,
    probe: async (host) =>
      host === '10.0.0.2'
        ? [devices[0]!, { ...devices[0]!, index: 1 }]
        : host === '10.0.0.3'
          ? devices
          : []
  })
  for (const host of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) {
    const peer = new Peer()
    swarm.connect(peer)
    peer.announce(`${host}:50052`)
  }
  const candidates = await result
  t.alike(
    candidates.map(({ devices }) => devices.length),
    [2, 1]
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
