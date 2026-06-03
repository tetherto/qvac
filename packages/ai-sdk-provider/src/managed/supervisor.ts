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
import { forgetServe, forgetServeSync, recordServe, sweepStaleServes } from './pid-tracker.js'

export interface SupervisorOptions {
  readonly models: readonly string[]
  readonly configPath: string
  readonly port?: number
  readonly host?: string
  readonly startTimeoutMs?: number
  // Grace period between SIGTERM and SIGKILL on shutdown. Internal/testing
  // knob; not surfaced on the public managed options.
  readonly shutdownGraceMs?: number
  readonly serveBinPath?: string
  // Forwarded to the health-check fetch (defaults to global fetch). Injectable
  // for tests; the provider's own `fetch` option is intentionally NOT reused
  // here since a caller's custom fetch may be scoped to the API surface.
  readonly fetchImpl?: typeof fetch
  // Cleanup for the ephemeral config, run after the serve is stopped.
  cleanupConfig?(): Promise<void>
}

export interface ServeSupervisor {
  readonly port: number
  readonly pid: number
  readonly baseURL: string
  stop(): Promise<void>
}

function delay (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Bind to port 0 and let the OS pick a free port, then immediately release it.
// There is an inherent TOCTOU race (another process could grab the port before
// the serve does), but it is vanishingly small on loopback and the serve will
// surface an EADDRINUSE we propagate as ServeExitedError.
function allocateFreePort (host: string): Promise<number> {
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
function resolveServeCommand (serveBinPath?: string): ServeCommand {
  if (serveBinPath !== undefined && serveBinPath.length > 0) {
    return { command: serveBinPath, baseArgs: [] }
  }

  const require = createRequire(import.meta.url)
  let pkgJsonPath: string
  try {
    pkgJsonPath = require.resolve('@qvac/cli/package.json')
  } catch (err) {
    throw new CliNotFoundError(err)
  }

  const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> }
  const binField = pkg.bin
  const binRel = typeof binField === 'string' ? binField : binField?.['qvac']
  if (binRel === undefined) {
    throw new CliNotFoundError(new Error('@qvac/cli package.json has no `qvac` bin entry'))
  }

  const entry = join(dirname(pkgJsonPath), binRel)
  return { command: process.execPath, baseArgs: [entry] }
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

  // Capture the child's exit/error in a holder object so the poll loop can fail
  // fast on a crash instead of waiting out the full timeout. A plain object
  // (rather than `let`) sidesteps TS's loop-narrowing of closure-assigned vars.
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

export async function startServeSupervisor (options: SupervisorOptions): Promise<ServeSupervisor> {
  const host = options.host ?? DEFAULT_SERVE_HOST
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_SERVE_START_TIMEOUT_MS
  const shutdownGraceMs = options.shutdownGraceMs ?? SERVE_SHUTDOWN_GRACE_MS
  const fetchImpl = options.fetchImpl ?? fetch

  // Reclaim any serves leaked by a previously crashed supervisor before we add
  // our own. Best-effort: never let a sweep failure block a fresh start.
  await sweepStaleServes({ killOrphans: true }).catch(() => {})

  const port = options.port ?? (await allocateFreePort(host))
  const { command, baseArgs } = resolveServeCommand(options.serveBinPath)
  const baseURL = `http://${host}:${port}/v1`

  const args = [
    ...baseArgs,
    'serve',
    'openai',
    '--config',
    options.configPath,
    '--port',
    String(port),
    '--host',
    host
  ]

  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const getTail = attachOutputTail(child)

  // Without a pid the spawn failed synchronously; the 'error' event will carry
  // the cause, so surface it deterministically here.
  if (child.pid === undefined) {
    await new Promise<void>((resolve) => child.once('error', () => resolve()))
    throw new ServeSpawnFailedError(`Failed to spawn ${command}`)
  }
  const pid = child.pid

  // ── Teardown wiring ───────────────────────────────────────────────────────
  let stopped = false

  function onProcessExit (): void {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch {
      // best-effort
    }
    forgetServeSync(pid)
  }
  function onSignal (signal: NodeJS.Signals): void {
    try {
      child.kill('SIGTERM')
    } catch {
      // best-effort
    }
    forgetServeSync(pid)
    // We overrode Node's default signal handling by attaching a listener, so we
    // must exit explicitly. 128 + signal number is the conventional code.
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  const signalHandler = onSignal as (signal: NodeJS.Signals) => void

  function removeTeardownHandlers (): void {
    process.removeListener('exit', onProcessExit)
    process.removeListener('SIGINT', signalHandler)
    process.removeListener('SIGTERM', signalHandler)
  }

  process.once('exit', onProcessExit)
  process.once('SIGINT', signalHandler)
  process.once('SIGTERM', signalHandler)

  async function stop (): Promise<void> {
    if (stopped) return
    stopped = true
    removeTeardownHandlers()

    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const killedHard = await Promise.race([
        exited.then(() => false),
        delay(shutdownGraceMs).then(() => true)
      ])
      if (killedHard) {
        child.kill('SIGKILL')
        await exited
      }
    }

    await forgetServe(pid).catch(() => {})
    if (options.cleanupConfig) await options.cleanupConfig().catch(() => {})
  }

  try {
    await recordServe({ pid, port, configPath: options.configPath, startedAt: new Date().toISOString() })
    await waitForHealth({ child, baseURL, timeoutMs: startTimeoutMs, fetchImpl, getTail })
  } catch (err) {
    await stop()
    throw err
  }

  return { port, pid, baseURL, stop }
}
