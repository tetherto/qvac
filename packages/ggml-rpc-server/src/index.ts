import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { connect, createServer, isIP } from 'node:net'
import { arch, platform } from 'node:process'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_RPC_SERVER_HOST: string = '127.0.0.1'
export const DEFAULT_RPC_SERVER_START_TIMEOUT_MS: number = 10000
export const DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS: number = 2000
export const RPC_SERVER_HEALTH_POLL_INTERVAL_MS: number = 100

const PREBUILD_MODULE_DIR = 'qvac__ggml-rpc-server'
const SUPPORTED_PREBUILD_TARGETS = new Set([
  'android-arm64',
  'darwin-arm64',
  'darwin-x64',
  'ios-arm64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
])
const RDMA_SUPPORT_MARKER = 'RDMA auto-negotiate enabled'
const RDMA_SUPPORT_MARKER_BYTES = Buffer.from(RDMA_SUPPORT_MARKER)
const TRUSTED_LAN_WARNING_CODE = 'QVAC_GGML_RPC_SERVER_TRUSTED_LAN'
const rdmaFileCache = new Map<string, {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  capable: boolean
}>()

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

export class RpcServerInvalidHostError extends Error {
  constructor(host: string) {
    super(`ggml-rpc-server requires an IPv4 address or localhost: ${host}`)
    this.name = 'RpcServerInvalidHostError'
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

export class RpcServerRdmaUnavailableError extends Error {
  readonly output: string

  constructor(output: string) {
    super('ggml-rpc-server was expected to support RDMA, but startup logs did not report RDMA auto-negotiation support')
    this.name = 'RpcServerRdmaUnavailableError'
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
  readonly threads?: number
  readonly env?: NodeJS.ProcessEnv
  readonly cleanupOnExit?: boolean
  readonly expectRdma?: boolean
  readonly allowNonLoopbackHost?: boolean
}

export interface RpcServerProcess {
  readonly runtime: 'process'
  readonly child: ChildProcess
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly url: string
  readonly device?: string
  /** `null` means capability was not checked because `expectRdma` was not set. */
  readonly rdmaCapable: boolean | null
  logs(): string
  stop(): Promise<void>
}

export interface AllocateFreePortOptions {
  readonly allowNonLoopbackHost?: boolean
}

export function resolveRpcServerPrebuildTarget(
  runtimePlatform: string = platform,
  runtimeArch: string = arch
): string {
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
    case 'android':
      if (runtimeArch === 'arm64') target = 'android-arm64'
      break
    case 'ios':
      if (runtimeArch === 'arm64') target = 'ios-arm64'
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
    resolveRpcServerPrebuildTarget(),
    PREBUILD_MODULE_DIR,
    binaryName()
  )
  if (!existsSync(resolved)) {
    throw new RpcServerBinaryNotFoundError(resolved)
  }
  return resolved
}

export function allocateFreePort(
  host = DEFAULT_RPC_SERVER_HOST,
  options: AllocateFreePortOptions = {}
): Promise<number> {
  const bindHost = normalizeHost(host)
  assertSupportedHost(bindHost)
  assertLoopbackHost(bindHost, options.allowNonLoopbackHost)
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err) => reject(new RpcServerPortAllocationError(err)))
    server.listen({ host: bindHost, port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new RpcServerPortAllocationError()))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function assertPortAvailable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err) => {
      reject(
        new RpcServerSpawnError(
          `Cannot start ggml-rpc-server because ${host}:${port} is unavailable`,
          err
        )
      )
    })
    server.listen({ host, port }, () => {
      server.close((err) => {
        if (err !== undefined) {
          reject(
            new RpcServerSpawnError(
              `Cannot start ggml-rpc-server because ${host}:${port} could not be released`,
              err
            )
          )
          return
        }
        resolve()
      })
    })
  })
}

export function rpcServerLogsIndicateRdmaSupport(logs: string): boolean {
  return logs.includes(RDMA_SUPPORT_MARKER)
}

function fileContainsRdmaSupportMarker(path: string): boolean {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) {
      rdmaFileCache.delete(path)
      return false
    }
    const cached = rdmaFileCache.get(path)
    if (
      cached !== undefined &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.ctimeMs === stats.ctimeMs &&
      cached.ino === stats.ino
    ) {
      return cached.capable
    }
    const capable = readFileSync(path).includes(RDMA_SUPPORT_MARKER_BYTES)
    rdmaFileCache.set(path, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      ino: stats.ino,
      capable
    })
    return capable
  } catch {
    rdmaFileCache.delete(path)
    return false
  }
}

function rpcServerBinaryIndicatesRdmaSupport(binaryPath: string): boolean {
  if (fileContainsRdmaSupportMarker(binaryPath)) {
    return true
  }

  try {
    for (const entry of readdirSync(dirname(binaryPath))) {
      if (!/\.(dll|dylib|so)$/.test(entry)) {
        continue
      }
      if (fileContainsRdmaSupportMarker(join(dirname(binaryPath), entry))) {
        return true
      }
    }
  } catch {
    return false
  }

  return false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isLoopbackHost(host: string): boolean {
  return isIP(host) === 4 && host.startsWith('127.')
}

function normalizeHost(host: string): string {
  return host === 'localhost' ? DEFAULT_RPC_SERVER_HOST : host
}

function assertSupportedHost(host: string): void {
  if (isIP(host) !== 4) {
    throw new RpcServerInvalidHostError(host)
  }
}

function assertLoopbackHost(host: string, allowNonLoopbackHost = false): void {
  if (allowNonLoopbackHost) {
    return
  }
  if (isLoopbackHost(host)) return
  throw new RpcServerNonLoopbackHostError(host)
}

function warnForTrustedLanHost(host: string, allowNonLoopbackHost = false): void {
  if (!allowNonLoopbackHost || isLoopbackHost(host)) {
    return
  }
  process.emitWarning(
    `ggml-rpc-server is binding to non-loopback host ${host}. The ggml RPC transport has no authentication or encryption; use this only on a trusted private network with external access controls.`,
    {
      code: TRUSTED_LAN_WARNING_CODE,
      type: 'Warning'
    }
  )
}

function attachOutputTail(child: ChildProcess, maxChars = 65536): () => string {
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

  const throwIfChildStopped = (): void => {
    if (state.spawnError !== null) {
      throw new RpcServerSpawnError(
        `Failed to spawn ggml-rpc-server: ${state.spawnError.message}`,
        state.spawnError
      )
    }
    if (state.exit !== null) {
      throw new RpcServerExitedError(state.exit.code, state.exit.signal, params.getTail())
    }
    // The child can exit before the listeners above are attached. Node retains
    // the terminal state on the ChildProcess even when the event was missed.
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new RpcServerExitedError(
        params.child.exitCode,
        params.child.signalCode,
        params.getTail()
      )
    }
  }

  while (true) {
    throwIfChildStopped()
    if (await canConnect(params.host, params.port)) {
      // A successful TCP connect alone is insufficient: an incumbent process
      // may already own the requested port while our child is still reporting
      // its bind failure. Give that failure one polling interval to surface,
      // then require both a live child and a listening endpoint.
      await delay(RPC_SERVER_HEALTH_POLL_INTERVAL_MS)
      throwIfChildStopped()
      if (await canConnect(params.host, params.port)) return
    }
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
  readonly threads?: number
}): string[] {
  const args = ['--host', options.host, '--port', String(options.port)]
  if (options.threads !== undefined) {
    args.push('--threads', String(options.threads))
  }
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

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError('port must be an integer between 1 and 65535')
  }
}

function validateDuration(name: string, value: number, allowZero: boolean): void {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} finite number`)
  }
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
  const signals: NodeJS.Signals[] = platform === 'win32'
    ? ['SIGINT', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP']
  const signalHandlers = signals.map((signal) => {
    const handler = (): void => {
      cleanup()
      detach()
      // A signal listener replaces Node's default exit behavior. Restore it only
      // when no application (or other managed server) is still handling the signal.
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal)
      }
    }
    return { signal, handler }
  })
  const detach = (): void => {
    process.removeListener('exit', cleanup)
    for (const { signal, handler } of signalHandlers) {
      process.removeListener(signal, handler)
    }
  }
  process.once('exit', cleanup)
  for (const { signal, handler } of signalHandlers) process.on(signal, handler)
  return detach
}

export async function startRpcServer(options: StartRpcServerOptions = {}): Promise<RpcServerProcess> {
  const host = normalizeHost(options.host ?? DEFAULT_RPC_SERVER_HOST)
  assertSupportedHost(host)
  assertLoopbackHost(host, options.allowNonLoopbackHost)
  warnForTrustedLanHost(host, options.allowNonLoopbackHost)
  if (options.port !== undefined) validatePort(options.port)
  if (options.startTimeoutMs !== undefined) {
    validateDuration('startTimeoutMs', options.startTimeoutMs, false)
  }
  if (options.shutdownGraceMs !== undefined) {
    validateDuration('shutdownGraceMs', options.shutdownGraceMs, true)
  }
  if (
    options.threads !== undefined &&
    (!Number.isSafeInteger(options.threads) || options.threads <= 0)
  ) {
    throw new TypeError('threads must be a positive integer')
  }
  const port =
    options.port ??
    (await allocateFreePort(host, {
      allowNonLoopbackHost: options.allowNonLoopbackHost,
    }))
  if (options.port !== undefined) {
    await assertPortAvailable(host, port)
  }
  const device = normalizeDevice(options.device)
  // Resolve before setting cwd so relative custom paths still name the same executable.
  const binaryPath = resolve(options.binaryPath ?? resolveRpcServerBinaryPath())
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_RPC_SERVER_START_TIMEOUT_MS
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS
  const args = rpcServerArgs({
    device,
    host,
    port,
    cache: options.cache ?? false,
    threads: options.threads
  })
  const spawnOptions: SpawnOptions = {
    cwd: dirname(binaryPath),
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

  let rdmaCapable: boolean | null = null
  try {
    await waitForListening({ child, host, port, timeoutMs: startTimeoutMs, getTail })
    // Logs are free to inspect. Only read the packaged binaries when the caller
    // explicitly requires RDMA capability and the logs do not report it.
    if (rpcServerLogsIndicateRdmaSupport(getTail())) {
      rdmaCapable = true
    } else if (options.expectRdma === true) {
      rdmaCapable = rpcServerBinaryIndicatesRdmaSupport(binaryPath) ||
        rpcServerLogsIndicateRdmaSupport(getTail())
    }
    if (options.expectRdma === true && rdmaCapable !== true) {
      throw new RpcServerRdmaUnavailableError(getTail())
    }
  } catch (err) {
    detachExitCleanup()
    await stopProcess(child, shutdownGraceMs).catch(() => {})
    throw err
  }

  child.once('exit', detachExitCleanup)

  return {
    runtime: 'process',
    child,
    pid: child.pid,
    host,
    port,
    url: `${host}:${port}`,
    device,
    rdmaCapable,
    logs: getTail,
    stop: async () => {
      detachExitCleanup()
      await stopProcess(child, shutdownGraceMs)
    }
  }
}
