import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import {
  DEFAULT_API_KEY,
  DEFAULT_HEADERS,
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_IDLE_TIMEOUT_MS,
  DEFAULT_SERVE_START_TIMEOUT_MS,
  PARENT_WATCH_INTERVAL_MS,
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
  isProcessAlive,
  lockPath,
  managedServesDir,
  readRecord,
  removeConsumer,
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
    return (await readFile(errorPath(fleetKey), 'utf8')).trim()
  } catch {
    return undefined
  }
}

// The pid recorded inside a lock file, or undefined if it's missing/empty/
// unreadable (e.g. a crashed writer left a zero-byte file, or we caught it in
// the tiny window between create and pid-write).
async function readLockOwner (key: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(lockPath(key), 'utf8')).trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function lockOlderThan (key: string, ms: number): Promise<boolean> {
  try {
    const st = await stat(lockPath(key))
    return Date.now() - st.mtimeMs > ms
  } catch {
    return true // vanished mid-check — treat as stealable
  }
}

// Best-effort exclusive spawn lock so two racing clients with the same fleet
// key don't both bring up a serve. The winner spawns; losers wait for its
// record. We steal a lock only when its owner process is gone: a healthy cold
// start can legitimately hold the lock for the whole serveStartTimeout (minutes
// of model download/preload), so a purely time-based steal would let a loser
// spawn a *duplicate* runner/serve and double-load the model. The mtime check
// is a fallback only for a lock whose owner pid we can't read.
// Exported for tests; not part of the package's public surface.
export async function tryLock (key: string): Promise<boolean> {
  await mkdir(managedServesDir(), { recursive: true })
  try {
    const fh = await open(lockPath(key), 'wx')
    await fh.writeFile(String(process.pid))
    await fh.close()
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const owner = await readLockOwner(key)
    if (owner !== undefined) {
      if (isProcessAlive(owner)) return false // owner still working — wait for its record
      await rm(lockPath(key), { force: true }).catch(() => {})
      return tryLock(key)
    }
    // Unknown owner: only steal once clearly stale, so we don't snatch a lock in
    // the window between its creation and the owner writing its pid.
    if (await lockOlderThan(key, SPAWN_LOCK_STALE_MS)) {
      await rm(lockPath(key), { force: true }).catch(() => {})
      return tryLock(key)
    }
    return false
  }
}

// Exported for tests; not part of the package's public surface.
export async function releaseLock (key: string): Promise<void> {
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
  const sharedKey = computeFleetKey(config, host, options.serveBinPath, options.servePort)

  // Reuse defaults on, except when a port is pinned (a pin signals "this exact
  // private serve"). A private serve gets a unique key so it never collides
  // with — or is reused by — a shared one, and is reaped as soon as its owner
  // goes away (idle timeout 0).
  const reuse = options.reuse ?? options.servePort === undefined
  const fleetKey = reuse ? sharedKey : `${sharedKey}-priv-${pid}-${randomBytes(4).toString('hex')}`
  const idleTimeoutMs = reuse ? (options.serveIdleTimeout ?? DEFAULT_SERVE_IDLE_TIMEOUT_MS) : 0

  // Optional parent-death pact (see `closeOnParentExit`). Armed *before*
  // resolveServe so it also covers a parent that dies during a long first-run
  // model download — at which point the provider isn't built yet, so we fall
  // back to deregistering the consumer directly. `providerClose` is filled in
  // once the provider (and its `close`) exist.
  let providerClose: (() => Promise<void>) | null = null
  let parentWatch: ReturnType<typeof setInterval> | undefined
  if (options.closeOnParentExit ?? false) {
    const parentPid = process.ppid
    parentWatch = setInterval(() => {
      if (!parentIsGone(parentPid, process.ppid)) return
      if (parentWatch !== undefined) clearInterval(parentWatch)
      void (async () => {
        if (providerClose !== null) await providerClose().catch(() => {})
        else removeConsumer(fleetKey, consumerId)
        process.exit(0)
      })()
    }, PARENT_WATCH_INTERVAL_MS)
    parentWatch.unref()
  }

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
    removeConsumer(fleetKey, consumerId)
    throw err
  }
  // Mutable live coordinates — updated on every respawn so the public getters
  // (and the fetch retarget) always describe the serve actually in use.
  const live = { baseURL: first.baseURL, port: first.port, servePid: first.servePid }

  // Set by close(); read by the fetch path so a request that loses the race with
  // close() never silently re-resolves (re-adding a consumer / spawning a runner
  // after the caller has detached).
  let closed = false

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
  // serve by re-resolving and retrying once. After close() we never re-resolve.
  const wrappedFetch: typeof fetch = async (input, init) => {
    try {
      return await baseFetch(retargetUrl(input, live.baseURL), init as RequestInit)
    } catch (err) {
      if (closed || !isRetryableConnError(err)) throw err
      const resolved = await reresolve()
      // close() may have won the race while we awaited: resolveServe re-added
      // our consumer marker after close() removed it (and dropped the exit
      // hook), so it would linger until process exit and keep the serve warm.
      // Undo the re-registration and surface the original error.
      if (closed) {
        removeConsumer(fleetKey, consumerId)
        throw err
      }
      live.baseURL = resolved.baseURL
      live.port = resolved.port
      live.servePid = resolved.servePid
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
    removeConsumer(fleetKey, consumerId)
  }
  process.once('exit', onExit)

  async function close (): Promise<void> {
    if (closed) return
    closed = true
    if (parentWatch !== undefined) clearInterval(parentWatch)
    process.removeListener('exit', onExit)
    removeConsumer(fleetKey, consumerId)
  }
  // Let the parent-death watch reuse the full close() path now that it exists.
  providerClose = close

  // Expose the coordinates as getters over `live` so they keep reflecting the
  // real serve after a crash-recovery respawn moves it to a new port/pid.
  Object.defineProperties(base, {
    baseURL: { get: () => live.baseURL, enumerable: true, configurable: true },
    port: { get: () => live.port, enumerable: true, configurable: true },
    pid: { get: () => live.servePid, enumerable: true, configurable: true }
  })
  const managed = Object.assign(base, { close, [Symbol.asyncDispose]: close })

  return managed as unknown as ManagedQvacProvider
}

// Swap the origin (scheme + host + port) of a request URL to the live serve's,
// preserving the path/query, so a respawn on a new port is transparent. Handles
// the three fetch input shapes (string, URL, Request); anything unparseable
// passes through. `@ai-sdk/openai-compatible` uses string URLs today, but
// handling Request keeps self-healing correct if a future version switches.
function retargetUrl (input: Parameters<typeof fetch>[0], baseURL: string): Parameters<typeof fetch>[0] {
  try {
    const live = new URL(baseURL)
    if (typeof input === 'string') {
      return retargetOrigin(new URL(input), live).toString()
    }
    if (input instanceof URL) {
      return retargetOrigin(new URL(input.toString()), live)
    }
    if (input instanceof Request) {
      const u = retargetOrigin(new URL(input.url), live)
      return new Request(u.toString(), input)
    }
  } catch {
    // unparseable input — leave it untouched
  }
  return input
}

function retargetOrigin (u: URL, live: URL): URL {
  u.protocol = live.protocol
  u.host = live.host
  return u
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

// Pure decision for the `closeOnParentExit` watch, factored out for testing. The
// parent is gone when our parent pid is no longer the one we started under: on
// POSIX a dead parent reparents us to init (ppid 1), and any change from the
// original pid is a reliable "parent exited" signal. Exported for tests.
export function parentIsGone (originalPpid: number, currentPpid: number): boolean {
  return currentPpid === 1 || currentPpid !== originalPpid
}
