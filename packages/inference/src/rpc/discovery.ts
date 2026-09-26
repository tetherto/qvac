import Hyperswarm, { type Connection } from 'hyperswarm'
import { Buffer } from 'bare-buffer'
import type { RequestContext } from '@/runtime/request-context'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { registerSwarm, unregisterSwarm } from '@/runtime/runtime-lifecycle'
import { getEngineLogger } from '@/logging/index'
import { delay, privateEndpoint, rpcTopic, throwIfAborted } from './network'
import { queryRpcDevices } from './inventory'
import type { RpcDevice, RpcServerCandidate } from '@/schemas/rpc-server'

const FRAME_LIMIT = 1024
const LEASE_MS = 3000
const MAX_CANDIDATES = 64

export function createDiscoverySwarm() {
  const swarm = new Hyperswarm({ maxPeers: 32 })
  swarm.on('error', (error) => getEngineLogger().warn('RPC discovery swarm:', error))
  registerSwarm(swarm, { label: 'rpc-discovery', createdAt: Date.now() })
  return swarm
}

export async function destroyDiscoverySwarm(swarm: Hyperswarm) {
  await swarm.destroy()
  unregisterSwarm(swarm)
}

export function parseAnnouncement(line: string): string | undefined {
  if (line.length > FRAME_LIMIT) return
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object') return
    const frame = value as Record<string, unknown>
    if (frame['version'] !== 1 || typeof frame['url'] !== 'string') return
    return privateEndpoint(frame['url']) ? frame['url'] : undefined
  } catch {
    return
  }
}

export async function advertiseRpcServer(
  topic: string,
  url: string,
  createSwarm = createDiscoverySwarm
): Promise<() => Promise<void>> {
  if (!privateEndpoint(url)) {
    throw new Error('RPC advertising requires a concrete private IPv4 endpoint')
  }
  const swarm = createSwarm()
  let withdrawn = false
  const connections = new Set<Connection>()
  const frame = JSON.stringify({ version: 1, url }) + '\n'
  const announce = () => {
    if (swarm.suspended) return
    for (const connection of connections) {
      if (!connection.destroyed && !connection.write(frame)) connection.destroy()
    }
  }
  swarm.on('connection', (connection) => {
    if (withdrawn || swarm.suspended) {
      connection.destroy()
      return
    }
    connection.on('error', () => {})
    connection.once('close', () => connections.delete(connection))
    // This protocol is one-way; clients never send requests to advertisers.
    connection.on('data', () => connection.destroy())
    connections.add(connection)
    if (!connection.write(frame)) connection.destroy()
  })
  const timer = setInterval(announce, 1000)
  async function withdraw() {
    withdrawn = true
    clearInterval(timer)
    for (const connection of connections) connection.destroy()
    await destroyDiscoverySwarm(swarm)
  }
  try {
    swarm.join(rpcTopic(topic), { server: true, client: false })
  } catch (error) {
    await withdraw()
    throw error
  }
  return withdraw
}

export async function discoverRpcEndpoints(
  topic: string,
  timeoutMs: number,
  ctx: RequestContext,
  deps: {
    createSwarm?: typeof createDiscoverySwarm
    probe?: typeof queryRpcDevices
  } = {}
): Promise<RpcServerCandidate[]> {
  await using scope = createDisposableScope()
  const swarm = (deps.createSwarm ?? createDiscoverySwarm)()
  scope.defer(() => destroyDiscoverySwarm(swarm))
  const candidates = new Map<Connection, { url: string; seen: number }>()
  const inventories = new Map<string, RpcDevice[]>()
  const probes = new Map<string, Promise<void>>()
  const deadline = Date.now() + timeoutMs
  const connections = new Set<Connection>()
  scope.defer(() => {
    for (const connection of connections) connection.destroy()
  })
  swarm.on('connection', (connection) => {
    if (connections.size >= MAX_CANDIDATES) {
      connection.destroy()
      return
    }
    connections.add(connection)
    let pending = Buffer.alloc(0)
    let frames = 0
    connection.on('error', () => {})
    connection.once('close', () => {
      candidates.delete(connection)
      connections.delete(connection)
    })
    connection.on('data', (chunk) => {
      if (Date.now() >= deadline || ctx.signal.aborted || swarm.suspended) return
      if (pending.length + chunk.length > FRAME_LIMIT) {
        connection.destroy()
        return
      }
      pending = Buffer.concat([pending, chunk])
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        // Bound work from a peer that ignores the one-second announcement interval.
        if (++frames > Math.ceil(timeoutMs / 1000) + 4) {
          connection.destroy()
          return
        }
        const url = parseAnnouncement(pending.subarray(0, newline).toString())
        pending = Buffer.from(pending.subarray(newline + 1))
        if (!url) {
          connection.destroy()
          return
        }
        const previous = candidates.get(connection)
        if (previous && previous.url !== url) {
          connection.destroy()
          return
        }
        candidates.set(connection, { url, seen: Date.now() })
        if (probes.has(url) || probes.size >= MAX_CANDIDATES) continue
        const endpoint = privateEndpoint(url)!
        const probe = (deps.probe ?? queryRpcDevices)(
          endpoint.host,
          endpoint.port,
          Math.max(1, Math.min(500, deadline - Date.now())),
          ctx.signal,
          scope
        )
          .then((devices) => {
            if (devices?.length) inventories.set(url, devices)
          })
          .catch(() => {})
        probes.set(url, probe)
      }
    })
  })
  swarm.join(rpcTopic(topic), { server: false, client: true })
  await delay(timeoutMs, ctx.signal)
  throwIfAborted(ctx.signal)
  // No cache survives the lookup. Closed peers and expired leases are excluded.
  if (swarm.suspended) return []
  const now = Date.now()
  return [
    ...new Set(
      [...candidates.values()]
        .filter(({ url, seen }) => now - seen < LEASE_MS && inventories.has(url))
        .map(({ url }) => url)
    )
  ].map((url) => ({ url, devices: inventories.get(url)! }))
}
