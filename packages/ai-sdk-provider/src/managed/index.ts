import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import {
  DEFAULT_API_KEY,
  DEFAULT_HEADERS,
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_IDLE_TIMEOUT_MS,
  DEFAULT_SERVE_START_TIMEOUT_MS,
  SERVE_HEALTH_POLL_INTERVAL_MS,
  SPAWN_LOCK_STALE_MS
} from '../defaults.js'
import type { ManagedQvacProvider, QvacManagedOptions } from '../types.js'
import { synthesizeServeConfig, writeEphemeralConfig } from './config-synthesizer.js'
import { ServeSpawnFailedError, ServeStartTimeoutError } from './errors.js'
import { computeFleetKey } from './fleet-key.js'
import {
  addConsumer,
  findReusableServe,
  healthCheck,
  lockPath,
  managedServesDir,
  readRecord,
  removeConsumer,
  removeConsumerSync,
  sweepServes
} from './registry.js'
import { runnerSpawnSpec } from './runner.js'
import { allocateFreePort } from './serve-process.js'

interface Resolved {
  readonly baseURL: string
  readonly servePid: number
  readonly port: number
}

function delay (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorPath (fleetKey: string): string {
  return join(managedServesDir(), `${fleetKey}.error`)
}

async function readErrorFile (fleetKey: string): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    return (await readFile(errorPath(fleetKey), 'utf8')).trim()
  } catch {
    return undefined
  }
}

// Best-effort exclusive spawn lock so two racing clients with the same fleet
// key don't both bring up a serve. The winner spawns; losers wait for its
// record. A lock older than SPAWN_LOCK_STALE_MS is assumed to be from a crashed
// spawner and stolen.
async function tryLock (key: string): Promise<boolean> {
  await mkdir(managedServesDir(), { recursive: true })
  try {
    const fh = await open(lockPath(key), 'wx')
    await fh.writeFile(String(process.pid))
    await fh.close()
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    try {
      const st = await stat(lockPath(key))
      if (Date.now() - st.mtimeMs > SPAWN_LOCK_STALE_MS) {
        await rm(lockPath(key), { force: true }).catch(() => {})
        return tryLock(key)
      }
    } catch {
      return tryLock(key) // lock vanished mid-check — retry
    }
    return false
  }
}

async function releaseLock (key: string): Promise<void> {
  await rm(lockPath(key), { force: true }).catch(() => {})
}

// Poll the registry until a healthy record appears for `fleetKey`, the runner
// reports a startup error, or `untilMs` passes. Returns the record, or
// undefined on the deadline (caller decides whether to retry or fail).
async function waitForHealthyRecord (
  fleetKey: string,
  fetchImpl: typeof fetch,
  untilMs: number
): Promise<Resolved | undefined> {
  while (Date.now() < untilMs) {
    const rec = await readRecord(fleetKey)
    if (rec !== undefined && (await healthCheck(rec.baseURL, fetchImpl))) {
      return { baseURL: rec.baseURL, servePid: rec.servePid, port: rec.port }
    }
    if ((await readErrorFile(fleetKey)) !== undefined) return undefined
    await delay(SERVE_HEALTH_POLL_INTERVAL_MS)
  }
  return undefined
}

function spawnRunner (params: {
  fleetKey: string
  configPath: string
  port: number
  host: string
  idleTimeoutMs: number
  startTimeoutMs: number
  serveBinPath?: string
}): void {
  const { command, args } = runnerSpawnSpec()
  const child = spawn(command, [...args, JSON.stringify(params)], {
    detached: true,
    stdio: process.env['QVAC_MANAGED_DEBUG'] !== undefined ? 'inherit' : 'ignore',
    env: process.env
  })
  // Fully detach: the runner outlives us so the serve can be shared and reaped
  // on its own idle schedule rather than dying with this client.
  child.unref()
}

export async function startManagedQvac (options: QvacManagedOptions): Promise<ManagedQvacProvider> {
  const host = options.serveHost ?? DEFAULT_SERVE_HOST
  const startTimeoutMs = options.serveStartTimeout ?? DEFAULT_SERVE_START_TIMEOUT_MS
  // Health checks (and respawn retries) use the raw fetch, never the provider's
  // own — a caller's custom fetch may be scoped to the API surface.
  const fetchImpl = options.fetch ?? fetch
  const pid = process.pid
  // A per-provider-instance consumer id (pid-prefixed so liveness pruning still
  // works) so two providers in this process sharing a fleet key each hold their
  // own marker — closing one must not deregister the other.
  const consumerId = `${pid}.${randomBytes(4).toString('hex')}`

  // Validate models eagerly (throws UnknownManagedModelError) and derive the
  // fleet key from the exact serve config we'd launch.
  const config = synthesizeServeConfig(options.models)
  const sharedKey = computeFleetKey(config, host, options.serveBinPath)

  // Reuse defaults on, except when a port is pinned (a pin signals "this exact
  // private serve"). A private serve gets a unique key so it never collides
  // with — or is reused by — a shared one, and is reaped as soon as its owner
  // goes away (idle timeout 0).
  const reuse = options.reuse ?? options.servePort === undefined
  const fleetKey = reuse ? sharedKey : `${sharedKey}-priv-${pid}-${randomBytes(4).toString('hex')}`
  const idleTimeoutMs = reuse ? (options.serveIdleTimeout ?? DEFAULT_SERVE_IDLE_TIMEOUT_MS) : 0

  async function resolveServe (): Promise<Resolved> {
    // Clear dead/orphaned records first so discovery and spawn see a clean slate.
    await sweepServes(fetchImpl).catch(() => {})

    if (reuse) {
      const existing = await findReusableServe(fleetKey, fetchImpl)
      if (existing !== undefined) {
        await addConsumer(fleetKey, consumerId)
        return { baseURL: existing.baseURL, servePid: existing.servePid, port: existing.port }
      }
    }

    // Register as a consumer before spawning so the runner never starts its
    // idle clock during the gap between spawn and attach.
    await addConsumer(fleetKey, consumerId)

    const overallDeadline = Date.now() + startTimeoutMs + 10_000
    while (true) {
      if (await tryLock(fleetKey)) {
        try {
          if (reuse) {
            const again = await findReusableServe(fleetKey, fetchImpl)
            if (again !== undefined) {
              return { baseURL: again.baseURL, servePid: again.servePid, port: again.port }
            }
          }
          const port = options.servePort ?? (await allocateFreePort(host))
          const ephemeral = await writeEphemeralConfig(options.models)
          await rm(errorPath(fleetKey), { force: true }).catch(() => {})

          spawnRunner({
            fleetKey,
            configPath: ephemeral.configPath,
            port,
            host,
            idleTimeoutMs,
            startTimeoutMs,
            ...(options.serveBinPath !== undefined ? { serveBinPath: options.serveBinPath } : {})
          })

          const rec = await waitForHealthyRecord(fleetKey, fetchImpl, overallDeadline)
          if (rec !== undefined) return rec

          // No healthy record: surface the runner's reason if it left one. The
          // runner owns config cleanup on failure; this is belt-and-braces.
          const errMsg = await readErrorFile(fleetKey)
          await ephemeral.cleanup().catch(() => {})
          if (errMsg !== undefined) {
            throw new ServeSpawnFailedError(`qvac serve failed to start: ${errMsg}`)
          }
          throw new ServeStartTimeoutError(startTimeoutMs, `http://${host}:${port}/v1`)
        } finally {
          await releaseLock(fleetKey)
        }
      }

      // Another client holds the spawn lock — wait for its record, in slices so
      // we can re-contend for the lock if that spawner crashed.
      const sliceUntil = Math.min(Date.now() + 5_000, overallDeadline)
      const rec = await waitForHealthyRecord(fleetKey, fetchImpl, sliceUntil)
      if (rec !== undefined) return rec
      if (Date.now() >= overallDeadline) {
        throw new ServeStartTimeoutError(startTimeoutMs, `http://${host}:?/v1`)
      }
    }
  }

  let first: Resolved
  try {
    first = await resolveServe()
  } catch (err) {
    // Resolution registered us as a consumer before it failed (timeout/spawn
    // error) — don't leave a stale-but-alive marker keeping a future serve on
    // this key warm longer than needed.
    removeConsumerSync(fleetKey, consumerId)
    await removeConsumer(fleetKey, consumerId).catch(() => {})
    throw err
  }
  const live = { baseURL: first.baseURL }

  // Single-flight re-resolution so a burst of in-flight requests hitting a dead
  // serve triggers exactly one recovery, not one per request.
  let resolving: Promise<Resolved> | null = null
  function reresolve (): Promise<Resolved> {
    resolving ??= resolveServe().finally(() => { resolving = null })
    return resolving
  }

  const baseFetch = options.fetch ?? fetch

  // Wrap fetch to (a) retarget every request at the currently-live serve origin
  // — so a respawn on a new port is transparent — and (b) recover from a dead
  // serve by re-resolving and retrying once.
  const wrappedFetch: typeof fetch = async (input, init) => {
    try {
      return await baseFetch(retargetUrl(input, live.baseURL), init as RequestInit)
    } catch (err) {
      if (!isRetryableConnError(err)) throw err
      const re = await reresolve()
      live.baseURL = re.baseURL
      return baseFetch(retargetUrl(input, live.baseURL), init as RequestInit)
    }
  }

  const headers = { ...DEFAULT_HEADERS, ...options.headers }
  const base = createOpenAICompatible({
    name: 'qvac',
    baseURL: live.baseURL,
    apiKey: options.apiKey ?? DEFAULT_API_KEY,
    headers,
    fetch: wrappedFetch
  })

  // Deregister on clean exit so the runner's idle clock can start promptly. An
  // abrupt termination (signal/crash) is handled by the runner's dead-pid
  // pruning, so we deliberately don't hijack SIGINT/SIGTERM here.
  function onExit (): void {
    removeConsumerSync(fleetKey, consumerId)
  }
  process.once('exit', onExit)

  let closed = false
  async function close (): Promise<void> {
    if (closed) return
    closed = true
    process.removeListener('exit', onExit)
    removeConsumerSync(fleetKey, consumerId)
    await removeConsumer(fleetKey, consumerId).catch(() => {})
  }

  const managed = Object.assign(base, {
    baseURL: first.baseURL,
    port: first.port,
    pid: first.servePid,
    close,
    [Symbol.asyncDispose]: close
  })

  return managed as unknown as ManagedQvacProvider
}

// Swap the origin (scheme + host + port) of a request URL to the live serve's,
// preserving the path/query. Best-effort: non-URL inputs pass through.
function retargetUrl (input: Parameters<typeof fetch>[0], baseURL: string): Parameters<typeof fetch>[0] {
  try {
    const live = new URL(baseURL)
    if (typeof input === 'string') {
      const u = new URL(input)
      u.protocol = live.protocol
      u.host = live.host
      return u.toString()
    }
    if (input instanceof URL) {
      const u = new URL(input.toString())
      u.protocol = live.protocol
      u.host = live.host
      return u
    }
  } catch {
    // not a parseable URL (e.g. a Request) — leave it untouched
  }
  return input
}

// Only ECONNREFUSED is retried: it means the connection was never established
// (the serve is down / respawned on a new port), so re-resolving and replaying
// the request is safe. We deliberately do NOT retry ECONNRESET/EPIPE — those
// can occur *after* the serve received and began processing a completion, so a
// blind replay could double-submit. Undici surfaces ECONNREFUSED as a
// `TypeError: fetch failed` with `cause.code`, which the cause check catches.
function isRetryableConnError (err: unknown): boolean {
  const e = err as { name?: string, code?: string, cause?: { code?: string } }
  if (e?.name === 'AbortError') return false // caller cancellation, not a dead serve
  return (e?.cause?.code ?? e?.code) === 'ECONNREFUSED'
}
