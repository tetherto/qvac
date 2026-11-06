import { Buffer } from 'bare-buffer'
import { randomBytes } from 'bare-crypto'
import AbortController from 'bare-abort-controller'
import type { RequestContext } from '@/runtime/request-context'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { delay, privateEndpoint, rpcTopic, throwIfAborted } from './network'
import { queryRpcInventory, type RpcInventory } from './inventory'
import { ANNOUNCEMENT_BYTES, createLanDiscovery } from './lan'
import type { RpcServerCandidate } from '@/schemas/rpc-server'

const LEASE_MS = 3000
const MAX_CANDIDATES = 64
const MAX_SOURCE_CANDIDATES = 8
const MAX_SOURCES = 128
const MAX_SOURCE_PROBES = 16
const MAX_PROBES = 128
const MAX_ACTIVE_PROBES = 4
const MAX_ENDPOINT_ATTEMPTS = 2
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
  createTransport = createLanDiscovery,
  onstatus?: (state: 'advertising' | 'suspended' | 'failed', error?: Error) => void,
  lanAddresses?: string[]
): Promise<() => Promise<void>> {
  const endpoint = privateEndpoint(url)
  if (!endpoint) throw new Error('RPC advertising requires a concrete private IPv4 endpoint')
  if (lanAddresses && !lanAddresses.includes(endpoint.host)) {
    throw new Error('RPC advertised endpoint must belong to lanAddresses')
  }
  const frame = Buffer.alloc(ANNOUNCEMENT_BYTES)
  frame.write(MAGIC, 0, 'ascii')
  frame[4] = 1
  rpcTopic(topic).copy(frame, 5)
  randomBytes(16).copy(frame, 37)
  frame.writeUInt16BE(endpoint.port, 53)
  const scope = createDisposableScope()
  const transport = createTransport({
    host: endpoint.host,
    ...(lanAddresses && { lanAddresses: [endpoint.host] }),
    onstart() {
      onstatus?.('advertising')
    },
    onstop(error) {
      onstatus?.(error ? 'failed' : 'suspended', error)
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
    onstatus?.('failed', error instanceof Error ? error : new Error(String(error)))
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
  } = {},
  lanAddresses?: string[]
): Promise<RpcServerCandidate[]> {
  throwIfAborted(ctx.signal)
  await using scope = createDisposableScope()
  const hash = rpcTopic(topic)
  const deadline = Date.now() + timeoutMs
  interface Candidate {
    instance: string
    seen: number
    source: string
    probing: boolean
    inventory?: RpcInventory
  }
  const candidates = new Map<string, Candidate>()
  interface Source {
    starts: number
    attempts: Map<string, { count: number; tried: number }>
  }
  const sources = new Map<string, Source>()
  let probes = 0
  let lastSource: string | undefined
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

  function reclaim() {
    for (const [url, candidate] of candidates) {
      const attempts = sources.get(candidate.source)?.attempts.get(url)?.count ?? 0
      if (
        Date.now() - candidate.seen >= LEASE_MS ||
        (!candidate.inventory && !candidate.probing && attempts >= MAX_ENDPOINT_ATTEMPTS)
      ) {
        candidates.delete(url)
      }
    }
  }

  function next() {
    const order = [...sources]
    const previous = order.findIndex(([host]) => host === lastSource)
    for (let i = 1; i <= order.length; i++) {
      const [host, source] = order[(previous + i) % order.length]!
      if (source.starts >= MAX_SOURCE_PROBES) continue
      for (const [url, candidate] of candidates) {
        const attempt = source.attempts.get(url)
        if (
          candidate.source === host &&
          !candidate.inventory &&
          !candidate.probing &&
          (attempt?.count ?? 0) < MAX_ENDPOINT_ATTEMPTS &&
          (!attempt || Date.now() - attempt.tried >= PROBE_MS)
        ) {
          lastSource = host
          return { url, candidate, source, attempt }
        }
      }
    }
    return undefined
  }

  function pump() {
    if (
      transport.suspended ||
      session.signal.aborted ||
      scope.disposed ||
      ctx.signal.aborted ||
      Date.now() >= deadline
    ) {
      return
    }
    reclaim()
    while (active < MAX_ACTIVE_PROBES && probes < MAX_PROBES) {
      const ready = next()
      if (!ready) break
      const { url, candidate, source, attempt } = ready
      const endpoint = privateEndpoint(url)!
      candidate.probing = true
      source.attempts.set(url, { count: (attempt?.count ?? 0) + 1, tried: Date.now() })
      source.starts++
      probes++
      active++
      const signal = session.signal
      const task = (async () => {
        try {
          const inventory = await (async () => {
            await using probeScope = createDisposableScope()
            return await (deps.probe ?? queryRpcInventory)(
              endpoint.host,
              endpoint.port,
              Math.max(1, Math.min(PROBE_MS, deadline - Date.now())),
              signal,
              probeScope
            )
          })()
          if (!signal.aborted && candidates.get(url) === candidate && inventory?.devices.length) {
            candidate.inventory = inventory
          }
        } catch {
          // Failed probes exclude this endpoint. The probe scope closes its TCP socket.
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
    ...(lanAddresses && { lanAddresses }),
    accept: (frame) => !!parseAnnouncement(frame, hash),
    onmessage(frame, host) {
      if (Date.now() >= deadline || ctx.signal.aborted || transport.suspended) return
      const announcement = parseAnnouncement(frame, hash)
      if (!announcement) return
      if (session.signal.aborted) session = new AbortController()
      const url = `${host}:${announcement.port}`
      if (!privateEndpoint(url)) return
      reclaim()
      let candidate = candidates.get(url)
      if (!candidate || candidate.instance !== announcement.instance) {
        // Instance changes invalidate inventory without resetting endpoint work.
        candidates.delete(url)
        let source = sources.get(host)
        if (!source) {
          if (sources.size >= MAX_SOURCES) return
          source = { starts: 0, attempts: new Map() }
          sources.set(host, source)
        }
        if (
          probes >= MAX_PROBES ||
          source.starts >= MAX_SOURCE_PROBES ||
          (source.attempts.get(url)?.count ?? 0) >= MAX_ENDPOINT_ATTEMPTS ||
          candidates.size >= MAX_CANDIDATES ||
          [...candidates.values()].filter((item) => item.source === host).length >=
            MAX_SOURCE_CANDIDATES
        ) {
          return
        }
        candidate = {
          instance: announcement.instance,
          seen: Date.now(),
          source: host,
          probing: false
        }
        candidates.set(url, candidate)
      }
      candidate.seen = Date.now()
      pump()
    },
    onstop(error) {
      session.abort(undefined)
      candidates.clear()
      for (const source of sources.values()) source.attempts.clear()
      if (error) {
        failure = error
        rejectFailure(error)
      }
    }
  })
  scope.defer(() => transport.close())
  const scheduler = setInterval(pump, 50)
  scope.defer(() => clearInterval(scheduler))
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
