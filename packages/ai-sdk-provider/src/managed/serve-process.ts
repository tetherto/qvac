import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_START_TIMEOUT_MS,
  SERVE_HEALTH_POLL_INTERVAL_MS,
  SERVE_SHUTDOWN_GRACE_MS
} from '../defaults.js'
import {
  CliNotFoundError,
  PortAllocationFailedError,
  ServeExitedError,
  ServeSpawnFailedError,
  ServeStartTimeoutError
} from './errors.js'

// Low-level lifecycle of a single `qvac serve openai` child: resolve the
// command, pick a port, spawn, wait until healthy, and stop. Deliberately
// free of any registry/process-handler coupling — the detached runner owns
// those concerns and uses these primitives.

function delay (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Bind to port 0 and let the OS pick a free port, then immediately release it.
// There is an inherent TOCTOU race (another process could grab the port before
// the serve does), but it is vanishingly small on loopback and the serve will
// surface an EADDRINUSE we propagate as ServeExitedError.
export function allocateFreePort (host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', (err) => reject(new PortAllocationFailedError(err)))
    srv.listen({ port: 0, host }, () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new PortAllocationFailedError()))
        return
      }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}

interface ServeCommand {
  readonly command: string
  readonly baseArgs: readonly string[]
}

// Resolve how to launch the serve. An explicit `serveBinPath` is spawned
// verbatim; otherwise the optional `@qvac/cli` peer dependency is resolved and
// run through the current Node/Bun executable (`process.execPath`) so we don't
// depend on the bin's exec bit or shebang — keeping it portable across Node 20+
// and Bun, per the task's "no Bun-specific APIs" requirement.
export function resolveServeCommand (serveBinPath?: string): ServeCommand {
  if (serveBinPath !== undefined && serveBinPath.length > 0) {
    return { command: serveBinPath, baseArgs: [] }
  }

  const require = createRequire(import.meta.url)

  // Preferred: read the `qvac` bin path from @qvac/cli's package.json. But the
  // published CLI ships a *string* `exports` ("./dist/index.js"), which makes
  // the `./package.json` subpath non-resolvable (ERR_PACKAGE_PATH_NOT_EXPORTED).
  // So this is best-effort; we fall back to resolving the package's main entry,
  // which for @qvac/cli is the same file as the `qvac` bin.
  try {
    const pkgJsonPath = require.resolve('@qvac/cli/package.json')
    const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> }
    const binField = pkg.bin
    const binRel = typeof binField === 'string' ? binField : binField?.['qvac']
    if (binRel !== undefined) {
      return { command: process.execPath, baseArgs: [join(dirname(pkgJsonPath), binRel)] }
    }
  } catch {
    // package.json not exported (or CLI absent) — fall through to main-entry
    // resolution, which throws a clean CliNotFoundError if the CLI is missing.
  }

  try {
    const entry = require.resolve('@qvac/cli')
    return { command: process.execPath, baseArgs: [entry] }
  } catch (err) {
    throw new CliNotFoundError(err)
  }
}

// Bounded ring buffer of the child's combined stdout/stderr so a startup
// failure can surface the tail of the serve's own diagnostics.
function attachOutputTail (child: ChildProcess, maxChars = 4000): () => string {
  let tail = ''
  function append (chunk: Buffer): void {
    tail = (tail + chunk.toString('utf8')).slice(-maxChars)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => tail
}

async function waitForHealth (params: {
  child: ChildProcess
  baseURL: string
  timeoutMs: number
  fetchImpl: typeof fetch
  getTail: () => string
}): Promise<void> {
  const { child, baseURL, timeoutMs, fetchImpl, getTail } = params
  const healthUrl = `${baseURL}/models`
  const deadline = Date.now() + timeoutMs

  const state: { exit: { code: number | null, signal: NodeJS.Signals | null } | null, spawnError: unknown } = {
    exit: null,
    spawnError: null
  }
  child.once('exit', (code, signal) => { state.exit = { code, signal } })
  child.once('error', (err) => { state.spawnError = err })

  while (true) {
    if (state.spawnError !== null) {
      throw new ServeSpawnFailedError(`Failed to spawn qvac serve: ${String(state.spawnError)}`, state.spawnError)
    }
    if (state.exit !== null) {
      throw new ServeExitedError(state.exit.code, state.exit.signal, getTail())
    }

    try {
      const controller = new AbortController()
      const attemptTimer = setTimeout(() => controller.abort(), 2000)
      try {
        const res = await fetchImpl(healthUrl, { signal: controller.signal })
        if (res.ok) return
      } finally {
        clearTimeout(attemptTimer)
      }
    } catch {
      // Connection refused / aborted: serve not listening yet. Keep polling.
    }

    if (Date.now() >= deadline) {
      throw new ServeStartTimeoutError(timeoutMs, baseURL)
    }
    await delay(SERVE_HEALTH_POLL_INTERVAL_MS)
  }
}

export interface SpawnServeOptions {
  readonly configPath: string
  readonly port: number
  readonly host?: string
  readonly startTimeoutMs?: number
  readonly serveBinPath?: string
  readonly fetchImpl?: typeof fetch
}

export interface SpawnedServe {
  readonly child: ChildProcess
  readonly pid: number
  readonly port: number
  readonly host: string
  readonly baseURL: string
}

// Spawn `qvac serve openai` on the given port and resolve once it answers a
// health check. On any failure the child is killed and a structured error is
// thrown, so the caller never leaks a half-started process.
export async function spawnServe (options: SpawnServeOptions): Promise<SpawnedServe> {
  const host = options.host ?? DEFAULT_SERVE_HOST
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_SERVE_START_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const { command, baseArgs } = resolveServeCommand(options.serveBinPath)
  const baseURL = `http://${host}:${options.port}/v1`

  const args = [
    ...baseArgs,
    'serve',
    'openai',
    '--config',
    options.configPath,
    '--port',
    String(options.port),
    '--host',
    host
  ]

  // `detached: true` makes the serve its own process-group leader (pgid == pid).
  // The serve spawns the `bare` inference worker as an ordinary child, which
  // inherits that group — so stopServe can signal the whole group and the worker
  // dies with the serve instead of orphaning (a plain SIGKILL of the serve pid
  // never cascades to a grandchild). We deliberately do NOT unref(): the runner
  // still owns the serve and must observe its 'exit'.
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true })
  const getTail = attachOutputTail(child)

  if (child.pid === undefined) {
    await new Promise<void>((resolve) => child.once('error', () => resolve()))
    throw new ServeSpawnFailedError(`Failed to spawn ${command}`)
  }

  try {
    await waitForHealth({ child, baseURL, timeoutMs: startTimeoutMs, fetchImpl, getTail })
  } catch (err) {
    await stopServe(child).catch(() => {})
    throw err
  }

  return { child, pid: child.pid, port: options.port, host, baseURL }
}

// Signal the serve *and* its descendants (the `bare` inference worker) as one
// unit. The serve is spawned detached, so it leads its own process group;
// signalling the negative pid reaches the whole group, guaranteeing the
// grandchild worker dies with the serve. Falls back to a direct child signal if
// the group send fails (e.g. the leader already exited) or on Windows, which has
// no POSIX process groups. Returns false only if nothing could be signalled.
function signalServeTree (child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid
  if (pid === undefined) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // No such group (leader already gone) or not a group leader — fall through
      // to a direct signal so we still make a best effort at the serve itself.
    }
  }
  try {
    child.kill(signal)
    return true
  } catch {
    return false
  }
}

// SIGTERM → grace → SIGKILL, mirroring the CLI's own shutdown ladder. The
// graceful SIGTERM is sent to the serve *process only* (not the group): the
// serve must be allowed to orchestrate its own shutdown — releasing the bare
// inference worker and its global worker lock — rather than us killing the
// worker out from under it (a SIGTERM straight to the worker terminates it
// before that cleanup, stranding a stale lock that blocks the next start). Only
// if the serve is wedged past the grace window do we escalate to a SIGKILL of
// the whole process group, so the worker can't survive as an orphan (a SIGKILL
// of the serve pid alone never cascades to the grandchild).
export async function stopServe (child: ChildProcess, graceMs = SERVE_SHUTDOWN_GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const killedHard = await Promise.race([
    exited.then(() => false),
    delay(graceMs).then(() => true)
  ])
  if (killedHard) {
    signalServeTree(child, 'SIGKILL')
    await exited
  }
}
