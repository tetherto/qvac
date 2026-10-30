import { Buffer } from 'bare-buffer'
import { randomBytes } from 'bare-crypto'
import AbortController from 'bare-abort-controller'
import type { RequestContext } from '@/runtime/request-context'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { getEngineLogger } from '@/logging/index'
import { delay, privateEndpoint, rpcTopic, throwIfAborted } from './network'
import { queryRpcInventory, type RpcInventory } from './inventory'
import { ANNOUNCEMENT_BYTES, createLanDiscovery } from './lan'
import type { RpcServerCandidate } from '@/schemas/rpc-server'

const LEASE_MS = 3000
const MAX_CANDIDATES = 64
const PROBE_MS = 500
const MAGIC = 'QVRP'

export function parseAnnouncement(frame: Buffer, topic: Buffer) {
  if (
    frame.length !== ANNOUNCEMENT_BYTES ||
    frame.toString('ascii', 0, 4) !== MAGIC ||
    frame[4] !== 1
  ) {
    return
  }
  if (!Buffer.from(frame.subarray(5, 37)).equals(topic)) return
  const port = frame.readUInt16BE(53)
  if (!port) return
  return { port, instance: Buffer.from(frame.subarray(37, 53)).toString('hex') }
}

export async function advertiseRpcServer(
  topic: string,
  url: string,
  ctx?: RequestContext,
  createTransport = createLanDiscovery
): Promise<() => Promise<void>> {
  const endpoint = privateEndpoint(url)
  if (!endpoint) throw new Error('RPC advertising requires a concrete private IPv4 endpoint')
  const frame = Buffer.alloc(ANNOUNCEMENT_BYTES)
  frame.write(MAGIC, 0, 'ascii')
  frame[4] = 1
  rpcTopic(topic).copy(frame, 5)
  randomBytes(16).copy(frame, 37)
  frame.writeUInt16BE(endpoint.port, 53)
  const scope = createDisposableScope()
  const transport = createTransport({
    host: endpoint.host,
    onstop(error) {
      if (error) getEngineLogger().warn('RPC LAN advertising stopped:', error)
    }
  })
  scope.defer(() => transport.close())
  const abort = () => {
    void transport.suspend()
  }
  ctx?.signal.addEventListener('abort', abort, { once: true })
  try {
    await transport.start(ctx?.signal)
    if (ctx) throwIfAborted(ctx.signal)
    await transport.send(frame)
    const timer = setInterval(() => {
      void transport.send(frame).catch(() => {})
    }, 1000)
    scope.defer(() => clearInterval(timer))
  } catch (error) {
    await scope[Symbol.asyncDispose]()
    if (ctx) throwIfAborted(ctx.signal)
    throw error
  } finally {
    ctx?.signal.removeEventListener('abort', abort)
  }
  return () => scope[Symbol.asyncDispose]()
}

export async function discoverRpcEndpoints(
  topic: string,
  timeoutMs: number,
  ctx: RequestContext,
  deps: {
    createTransport?: typeof createLanDiscovery
    probe?: typeof queryRpcInventory
  } = {}
): Promise<RpcServerCandidate[]> {
  throwIfAborted(ctx.signal)
  await using scope = createDisposableScope()
  const hash = rpcTopic(topic)
  const deadline = Date.now() + timeoutMs
  interface Candidate {
    instance: string
    seen: number
    attempts: number
    tried: number
    probing: boolean
    inventory?: RpcInventory
  }
  const candidates = new Map<string, Candidate>()
  const admitted = new Set<string>()
  const attempts = new Map<string, number>()
  const pending = new Set<Promise<void>>()
  let session = new AbortController()
  const wait = new AbortController()
  let active = 0
  let failure: Error | undefined
  let rejectFailure: (error: Error) => void = () => {}
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  // A bind error may arrive before the wait starts.
  void failed.catch(() => {})
  const abort = () => {
    session.abort(undefined)
    wait.abort(undefined)
  }
  ctx.signal.addEventListener('abort', abort, { once: true })
  scope.defer(async () => {
    ctx.signal.removeEventListener('abort', abort)
    abort()
    await Promise.allSettled(pending)
  })

  function pump() {
    if (transport.suspended || scope.disposed || ctx.signal.aborted || Date.now() >= deadline) {
      return
    }
    for (const [url, candidate] of candidates) {
      if (active >= 4) break
      if (
        candidate.inventory ||
        candidate.probing ||
        candidate.attempts >= 2 ||
        Date.now() - candidate.seen >= LEASE_MS ||
        Date.now() - candidate.tried < PROBE_MS
      ) {
        continue
      }
      const endpoint = privateEndpoint(url)!
      candidate.probing = true
      candidate.attempts++
      attempts.set(url, candidate.attempts)
      candidate.tried = Date.now()
      active++
      const signal = session.signal
      const task = (async () => {
        await using probeScope = createDisposableScope()
        try {
          const inventory = await (deps.probe ?? queryRpcInventory)(
            endpoint.host,
            endpoint.port,
            Math.max(1, Math.min(PROBE_MS, deadline - Date.now())),
            signal,
            probeScope
          )
          if (!signal.aborted && candidates.get(url) === candidate && inventory?.devices.length) {
            candidate.inventory = inventory
          }
        } catch {
          /* Failed probes exclude this endpoint. Cancellation also closes the TCP socket. */
        } finally {
          active--
          candidate.probing = false
          pump()
        }
      })()
      pending.add(task)
      void task.finally(() => pending.delete(task))
    }
  }

  const transport = (deps.createTransport ?? createLanDiscovery)({
    onmessage(frame, host) {
      if (Date.now() >= deadline || ctx.signal.aborted || transport.suspended) return
      const announcement = parseAnnouncement(frame, hash)
      if (!announcement) return
      if (session.signal.aborted) session = new AbortController()
      const url = `${host}:${announcement.port}`
      if (!privateEndpoint(url)) return
      if (!admitted.has(url)) {
        if (admitted.size >= MAX_CANDIDATES) return
        admitted.add(url)
      }
      let candidate = candidates.get(url)
      if (!candidate || candidate.instance !== announcement.instance) {
        // One endpoint gets at most two probes per lookup, including restarts.
        if ((attempts.get(url) ?? 0) >= 2) return
        candidate = {
          instance: announcement.instance,
          seen: Date.now(),
          attempts: attempts.get(url) ?? 0,
          tried: 0,
          probing: false
        }
        candidates.set(url, candidate)
      }
      candidate.seen = Date.now()
      pump()
    },
    onstop(error) {
      candidates.clear()
      session.abort(undefined)
      if (error) {
        failure = error
        rejectFailure(error)
      }
    }
  })
  scope.defer(() => transport.close())
  await transport.start(ctx.signal)
  await Promise.race([delay(Math.max(0, deadline - Date.now()), wait.signal), failed])
  throwIfAborted(ctx.signal)
  if (failure) throw failure
  if (transport.suspended) return []
  return [...candidates].flatMap(([url, candidate]) =>
    Date.now() - candidate.seen < LEASE_MS && candidate.inventory
      ? [{ url, ...candidate.inventory }]
      : []
  )
}
