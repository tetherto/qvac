import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, createServer, isIP } from 'node:net'
import { arch, platform } from 'node:process'
import { join } from 'node:path'

export const DEFAULT_RPC_SERVER_HOST: string = '127.0.0.1'
export const DEFAULT_RPC_SERVER_START_TIMEOUT_MS: number = 10000
export const DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS: number = 2000
export const RPC_SERVER_HEALTH_POLL_INTERVAL_MS: number = 100

const PREBUILD_MODULE_DIR = 'qvac__llm-rpc-server'
const SUPPORTED_PREBUILD_TARGETS = new Set(['darwin-arm64', 'linux-x64'])

export class RpcServerBinaryNotFoundError extends Error {
  constructor(path: string) {
    super(`ggml-rpc-server binary was not found at ${path}`)
    this.name = 'RpcServerBinaryNotFoundError'
  }
}

export class RpcServerUnsupportedPlatformError extends Error {
  constructor(runtimePlatform: string, runtimeArch: string) {
    super(`ggml-rpc-server is not packaged for ${runtimePlatform}-${runtimeArch}`)
    this.name = 'RpcServerUnsupportedPlatformError'
  }
}

export class RpcServerPortAllocationError extends Error {
  constructor(cause?: unknown) {
    super('Failed to allocate a free port for ggml-rpc-server', { cause })
    this.name = 'RpcServerPortAllocationError'
  }
}

export class RpcServerNonLoopbackHostError extends Error {
  constructor(host: string) {
    super(`ggml-rpc-server only supports loopback hosts in this package: ${host}`)
    this.name = 'RpcServerNonLoopbackHostError'
  }
}

export class RpcServerSpawnError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RpcServerSpawnError'
  }
}

export class RpcServerExitedError extends Error {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly output: string

  constructor(code: number | null, signal: NodeJS.Signals | null, output: string) {
    super(`ggml-rpc-server exited before it was ready: code=${String(code)} signal=${String(signal)}`)
    this.name = 'RpcServerExitedError'
    this.code = code
    this.signal = signal
    this.output = output
  }
}

export class RpcServerStartTimeoutError extends Error {
  readonly host: string
  readonly port: number
  readonly timeoutMs: number
  readonly output: string

  constructor(host: string, port: number, timeoutMs: number, output: string) {
    super(`ggml-rpc-server did not listen on ${host}:${port} within ${timeoutMs}ms`)
    this.name = 'RpcServerStartTimeoutError'
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
    this.output = output
  }
}

export interface StartRpcServerOptions {
  readonly device?: string | readonly string[]
  readonly host?: string
  readonly port?: number
  readonly cache?: boolean
  readonly binaryPath?: string
  readonly startTimeoutMs?: number
  readonly shutdownGraceMs?: number
  readonly env?: NodeJS.ProcessEnv
  readonly cleanupOnExit?: boolean
}

export interface RpcServerProcess {
  readonly child: ChildProcess
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly url: string
  readonly device?: string
  logs(): string
  stop(): Promise<void>
}

function prebuildTarget(runtimePlatform = platform, runtimeArch = arch): string {
  let target: string | undefined
  switch (runtimePlatform) {
    case 'darwin':
      if (runtimeArch === 'arm64') target = 'darwin-arm64'
      if (runtimeArch === 'x64') target = 'darwin-x64'
      break
    case 'linux':
      if (runtimeArch === 'x64') target = 'linux-x64'
      if (runtimeArch === 'arm64') target = 'linux-arm64'
      break
    case 'win32':
      if (runtimeArch === 'x64') target = 'win32-x64'
      break
  }
  if (target !== undefined && SUPPORTED_PREBUILD_TARGETS.has(target)) {
    return target
  }
  throw new RpcServerUnsupportedPlatformError(runtimePlatform, runtimeArch)
}

function binaryName(runtimePlatform = platform): string {
  return runtimePlatform === 'win32' ? 'ggml-rpc-server.exe' : 'ggml-rpc-server'
}

export function resolveRpcServerBinaryPath(): string {
  const resolved = join(
    __dirname,
    'prebuilds',
    prebuildTarget(),
    PREBUILD_MODULE_DIR,
    binaryName()
  )
  if (!existsSync(resolved)) {
    throw new RpcServerBinaryNotFoundError(resolved)
  }
  return resolved
}

export function allocateFreePort(host = DEFAULT_RPC_SERVER_HOST): Promise<number> {
  assertLoopbackHost(host)
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err) => reject(new RpcServerPortAllocationError(err)))
    server.listen({ host, port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new RpcServerPortAllocationError()))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertLoopbackHost(host: string): void {
  if (host === 'localhost' || host === '::1') return
  if (isIP(host) === 4 && host.startsWith('127.')) return
  throw new RpcServerNonLoopbackHostError(host)
}

function attachOutputTail(child: ChildProcess, maxChars = 4000): () => string {
  let tail = ''
  function append(chunk: Buffer): void {
    tail = (tail + chunk.toString('utf8')).slice(-maxChars)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => tail
}

function canConnect(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const done = (connected: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(connected)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => {
      done(true)
    })
    socket.once('error', () => {
      done(false)
    })
  })
}

async function waitForListening(params: {
  readonly child: ChildProcess
  readonly host: string
  readonly port: number
  readonly timeoutMs: number
  readonly getTail: () => string
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs
  const state: {
    exit: { code: number | null; signal: NodeJS.Signals | null } | null
    spawnError: Error | null
  } = {
    exit: null,
    spawnError: null
  }
  params.child.once('exit', (code, signal) => {
    state.exit = { code, signal }
  })
  params.child.once('error', (err) => {
    state.spawnError = err
  })

  while (true) {
    if (state.spawnError !== null) {
      throw new RpcServerSpawnError(`Failed to spawn ggml-rpc-server: ${state.spawnError.message}`, state.spawnError)
    }
    if (state.exit !== null) {
      throw new RpcServerExitedError(state.exit.code, state.exit.signal, params.getTail())
    }
    if (await canConnect(params.host, params.port)) return
    if (Date.now() >= deadline) {
      throw new RpcServerStartTimeoutError(params.host, params.port, params.timeoutMs, params.getTail())
    }
    await delay(RPC_SERVER_HEALTH_POLL_INTERVAL_MS)
  }
}

function rpcServerArgs(options: {
  readonly device?: string
  readonly host: string
  readonly port: number
  readonly cache: boolean
}): string[] {
  const args = ['--host', options.host, '--port', String(options.port)]
  if (options.device !== undefined && options.device.length > 0) {
    args.push('--device', options.device)
  }
  if (options.cache) args.push('--cache')
  return args
}

function normalizeDevice(device: string | readonly string[] | undefined): string | undefined {
  if (typeof device === 'string' || device === undefined) return device
  return device.join(',')
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid
  if (pid === undefined) return false
  if (platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // Fall through to direct signalling below.
    }
  }
  try {
    child.kill(signal)
    return true
  } catch {
    return false
  }
}

async function stopProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const timedOut = await Promise.race([exited.then(() => false), delay(graceMs).then(() => true)])
  if (timedOut) {
    signalProcessTree(child, 'SIGKILL')
    await Promise.race([exited, delay(500)])
  }
}

function attachExitCleanup(child: ChildProcess): () => void {
  const cleanup = (): void => {
    signalProcessTree(child, 'SIGTERM')
  }
  process.once('exit', cleanup)
  return () => process.removeListener('exit', cleanup)
}

export async function startRpcServer(options: StartRpcServerOptions = {}): Promise<RpcServerProcess> {
  const host = options.host ?? DEFAULT_RPC_SERVER_HOST
  assertLoopbackHost(host)
  const port = options.port ?? (await allocateFreePort(host))
  const device = normalizeDevice(options.device)
  const binaryPath = options.binaryPath ?? resolveRpcServerBinaryPath()
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_RPC_SERVER_START_TIMEOUT_MS
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS
  const args = rpcServerArgs({
    device,
    host,
    port,
    cache: options.cache ?? false
  })
  const spawnOptions: SpawnOptions = {
    detached: true,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  }
  const child = spawn(binaryPath, args, spawnOptions)
  const getTail = attachOutputTail(child)
  const detachExitCleanup = options.cleanupOnExit === false
    ? () => {}
    : attachExitCleanup(child)

  if (child.pid === undefined) {
    await new Promise<void>((resolve) => child.once('error', () => resolve()))
    detachExitCleanup()
    throw new RpcServerSpawnError(`Failed to spawn ${binaryPath}`)
  }

  try {
    await waitForListening({ child, host, port, timeoutMs: startTimeoutMs, getTail })
  } catch (err) {
    detachExitCleanup()
    await stopProcess(child, shutdownGraceMs).catch(() => {})
    throw err
  }

  child.once('exit', detachExitCleanup)

  return {
    child,
    pid: child.pid,
    host,
    port,
    url: `${host}:${port}`,
    device,
    logs: getTail,
    stop: async () => {
      detachExitCleanup()
      await stopProcess(child, shutdownGraceMs)
    }
  }
}
