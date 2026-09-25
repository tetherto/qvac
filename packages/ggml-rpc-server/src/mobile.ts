/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and native bindings expose CommonJS export shapes. */
import net = require('bare-net')
import path = require('bare-path')

const binding = require('./binding') as RpcServerBinding
/* eslint-enable @typescript-eslint/no-require-imports */

export const DEFAULT_RPC_SERVER_HOST: string = '127.0.0.1'

const TRUSTED_LAN_WARNING_CODE = 'QVAC_GGML_RPC_SERVER_TRUSTED_LAN'
const PACKAGED_BACKENDS_DIR = path.join(__dirname, 'prebuilds')
// Keep native handles alive until an explicit stop finishes. Otherwise their
// finalizer can synchronously stop and join a live server during garbage collection.
const activeServerHandles = new Set<object>()

interface RpcServerBinding {
  startServer(options: {
    readonly endpoint: string
    readonly device?: string
    readonly cache: boolean
    readonly threads?: number
    readonly backendsDir: string
  }): Promise<object>
  stopServer(handle: object): Promise<void>
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

export class RpcServerRdmaUnavailableError extends Error {
  readonly output: string

  constructor(output: string) {
    super('RDMA is not available for the in-process Android/iOS RPC server')
    this.name = 'RpcServerRdmaUnavailableError'
    this.output = output
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

export interface RpcServerProcess {
  readonly runtime: 'in-process'
  readonly host: string
  readonly port: number
  readonly url: string
  readonly device?: string
  readonly rdmaCapable: false
  logs(): string
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
  if (typeof device === 'string' || device === undefined) return device
  return device.join(',')
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

export async function startRpcServer(options: StartRpcServerOptions = {}): Promise<RpcServerProcess> {
  const host = normalizeHost(options.host ?? DEFAULT_RPC_SERVER_HOST)
  assertSupportedHost(host)
  assertLoopbackHost(host, options.allowNonLoopbackHost)
  warnForTrustedLanHost(host, options.allowNonLoopbackHost)
  if (options.expectRdma === true) {
    throw new RpcServerRdmaUnavailableError('')
  }
  validateThreads(options.threads)
  const port =
    options.port ??
    (await allocateFreePort(host, {
      allowNonLoopbackHost: options.allowNonLoopbackHost
    }))
  validatePort(port)
  const device = normalizeDevice(options.device)
  const handle = await binding.startServer({
    endpoint: `${host}:${port}`,
    device,
    cache: options.cache ?? false,
    threads: options.threads,
    backendsDir: PACKAGED_BACKENDS_DIR
  })
  activeServerHandles.add(handle)
  let stopPromise: Promise<void> | undefined

  return {
    runtime: 'in-process',
    host,
    port,
    url: `${host}:${port}`,
    device,
    rdmaCapable: false,
    logs: () => '',
    stop: () => {
      stopPromise ??= binding.stopServer(handle).then(
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
