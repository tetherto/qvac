/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and native bindings expose CommonJS export shapes. */
import net = require('bare-net')

const binding = require('./binding') as RpcServerBinding
/* eslint-enable @typescript-eslint/no-require-imports */

export const DEFAULT_RPC_SERVER_HOST: string = '127.0.0.1'

const TRUSTED_LAN_WARNING_CODE = 'QVAC_GGML_RPC_SERVER_TRUSTED_LAN'
// Keep native handles alive until an explicit stop finishes. Otherwise their
// finalizer can synchronously stop and join a live server during garbage collection.
const activeServerHandles = new Set<object>()
// Fabric never unloads its RPC module, so its RDMA build cannot change within a
// process. Cache the native check, which reads the module from disk.
let rdmaSupport: boolean | undefined

interface RpcServerBinding {
  startServer(options: {
    readonly endpoint: string
    readonly device?: string
    readonly cache: boolean
    readonly threads?: number
  }): Promise<object>
  stopServer(handle: object): Promise<void>
  rpcBackendSupportsRdma(options: Record<string, never>): boolean
}

export class RpcServerPortAllocationError extends Error {
  constructor(cause?: unknown) {
    super('Failed to allocate a free port for ggml-rpc-server', { cause })
    this.name = 'RpcServerPortAllocationError'
  }
}

export class RpcServerNonLoopbackHostError extends Error {
  constructor(host: string) {
    super(
      `${host} is not a loopback host; pass allowNonLoopbackHost: true to bind it on a trusted network`
    )
    this.name = 'RpcServerNonLoopbackHostError'
  }
}

export class RpcServerInvalidHostError extends Error {
  constructor(host: string) {
    super(`ggml-rpc-server requires an IPv4 address or localhost: ${host}`)
    this.name = 'RpcServerInvalidHostError'
  }
}

export class RpcServerRdmaUnavailableError extends Error {
  constructor() {
    super('RDMA is not available in the installed @qvac/fabric RPC backend')
    this.name = 'RpcServerRdmaUnavailableError'
  }
}

/**
 * A failure reported by the native server. The addon raises plain errors with a
 * `code`; these classes let callers branch on `name` or `instanceof` as they do
 * for the errors above. `code` equals `name`, and `cause` is the native error.
 */
export abstract class RpcServerNativeError extends Error {
  readonly code: string

  // Names are literals, not new.target.name, so they survive minification.
  constructor(name: string, message: string, cause: unknown) {
    super(message, { cause })
    this.name = name
    this.code = name
  }
}

/** No requested device exists, or no device is available. */
export class RpcServerDeviceError extends RpcServerNativeError {
  constructor(message: string, cause: unknown) {
    super('RpcServerDeviceError', message, cause)
  }
}

/** The RPC cache directory could not be resolved or created. */
export class RpcServerCacheError extends RpcServerNativeError {
  constructor(message: string, cause: unknown) {
    super('RpcServerCacheError', message, cause)
  }
}

/** The server could not be created or bound, or the RPC backend is missing. */
export class RpcServerStartError extends RpcServerNativeError {
  constructor(message: string, cause: unknown) {
    super('RpcServerStartError', message, cause)
  }
}

/** The Fabric backends directory is invalid or could not be inspected. */
export class RpcServerBackendError extends RpcServerNativeError {
  constructor(message: string, cause: unknown) {
    super('RpcServerBackendError', message, cause)
  }
}

/** The server did not stop cleanly. */
export class RpcServerStopError extends RpcServerNativeError {
  constructor(message: string, cause: unknown) {
    super('RpcServerStopError', message, cause)
  }
}

const nativeErrorClasses = new Map<
  string,
  new (message: string, cause: unknown) => RpcServerNativeError
>([
  ['RpcServerDeviceError', RpcServerDeviceError],
  ['RpcServerCacheError', RpcServerCacheError],
  ['RpcServerStartError', RpcServerStartError],
  ['RpcServerBackendError', RpcServerBackendError],
  ['RpcServerStopError', RpcServerStopError]
])

function toTypedError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code
  const ErrorClass = typeof code === 'string' ? nativeErrorClasses.get(code) : undefined
  return ErrorClass === undefined ? error : new ErrorClass((error as Error).message, error)
}

async function callNative<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw toTypedError(error)
  }
}

export interface StartRpcServerOptions {
  readonly device?: string | readonly string[]
  readonly host?: string
  readonly port?: number
  readonly cache?: boolean
  readonly threads?: number
  readonly expectRdma?: boolean
  readonly allowNonLoopbackHost?: boolean
}

export interface RpcServer {
  readonly host: string
  readonly port: number
  readonly url: string
  readonly device?: string
  /**
   * Whether the loaded Fabric RPC backend was built with RDMA. Such a backend
   * negotiates RDMA with each RDMA-capable client and falls back to TCP otherwise.
   */
  readonly rdmaCapable: boolean
  stop(): Promise<void>
}

export interface AllocateFreePortOptions {
  readonly allowNonLoopbackHost?: boolean
}

function isLoopbackHost(host: string): boolean {
  const parts = host.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function isIpv4Host(host: string): boolean {
  const parts = host.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function normalizeHost(host: string): string {
  return host === 'localhost' ? DEFAULT_RPC_SERVER_HOST : host
}

function assertSupportedHost(host: string): void {
  if (!isIpv4Host(host)) {
    throw new RpcServerInvalidHostError(host)
  }
}

function assertLoopbackHost(host: string, allowNonLoopbackHost = false): void {
  if (!allowNonLoopbackHost && !isLoopbackHost(host)) {
    throw new RpcServerNonLoopbackHostError(host)
  }
}

function warnForTrustedLanHost(host: string, allowNonLoopbackHost = false): void {
  if (!allowNonLoopbackHost || isLoopbackHost(host)) return
  console.warn(
    `[${TRUSTED_LAN_WARNING_CODE}] ggml-rpc-server is binding to non-loopback host ${host}. ` +
      'The ggml RPC transport has no authentication or encryption; use this only on a trusted private network with external access controls.'
  )
}

function normalizeDevice(device: string | readonly string[] | undefined): string | undefined {
  if (device === undefined) return undefined
  // The native side splits on ',' or '/' and matches names exactly, so trim
  // each name: 'Vulkan0, CPU' would otherwise look up ' CPU'.
  const names = typeof device === 'string' ? device.split(/[,/]/) : device
  const trimmed = names.map((name) => name.trim())
  // A blank-only value must not collapse to '', which means "default devices".
  // Pass it through untouched so the native side rejects it as unknown.
  if (trimmed.every((name) => name === '') && names.some((name) => name !== '')) {
    return names.join(',')
  }
  return trimmed.join(',')
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError('port must be an integer between 1 and 65535')
  }
}

function validateThreads(threads: number | undefined): void {
  if (threads !== undefined && (!Number.isSafeInteger(threads) || threads <= 0)) {
    throw new TypeError('threads must be a positive integer')
  }
}

// The RPC module @qvac/fabric loads, from wherever fabric ships its backends.
function rpcBackendSupportsRdma(): boolean {
  if (rdmaSupport === undefined) {
    try {
      rdmaSupport = binding.rpcBackendSupportsRdma({})
    } catch (error) {
      throw toTypedError(error)
    }
  }
  return rdmaSupport
}

export function allocateFreePort(
  host = DEFAULT_RPC_SERVER_HOST,
  options: AllocateFreePortOptions = {}
): Promise<number> {
  const bindHost = normalizeHost(host)
  assertSupportedHost(bindHost)
  assertLoopbackHost(bindHost, options.allowNonLoopbackHost)
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error: Error) => reject(new RpcServerPortAllocationError(error)))
    server.listen(0, bindHost, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new RpcServerPortAllocationError()))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

export async function startRpcServer(options: StartRpcServerOptions = {}): Promise<RpcServer> {
  const host = normalizeHost(options.host ?? DEFAULT_RPC_SERVER_HOST)
  assertSupportedHost(host)
  assertLoopbackHost(host, options.allowNonLoopbackHost)
  warnForTrustedLanHost(host, options.allowNonLoopbackHost)
  validateThreads(options.threads)
  const rdmaCapable = rpcBackendSupportsRdma()
  if (options.expectRdma === true && !rdmaCapable) {
    throw new RpcServerRdmaUnavailableError()
  }
  const port =
    options.port ??
    (await allocateFreePort(host, {
      allowNonLoopbackHost: options.allowNonLoopbackHost
    }))
  validatePort(port)
  const device = normalizeDevice(options.device)
  const handle = await callNative(() =>
    binding.startServer({
      endpoint: `${host}:${port}`,
      device,
      cache: options.cache ?? false,
      threads: options.threads
    })
  )
  activeServerHandles.add(handle)
  let stopPromise: Promise<void> | undefined

  return {
    host,
    port,
    url: `${host}:${port}`,
    device,
    rdmaCapable,
    stop: () => {
      stopPromise ??= callNative(() => binding.stopServer(handle)).then(
        () => {
          activeServerHandles.delete(handle)
        },
        (error: unknown) => {
          // Keep the handle pinned so the caller can retry a failed stop.
          stopPromise = undefined
          throw error
        }
      )
      return stopPromise
    }
  }
}
