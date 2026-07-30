import RPC from 'bare-rpc'
import { connect } from 'bare-net'
import { handleRequest } from './handle-request'
import type { Duplex, DuplexEvents } from 'bare-stream'
import { getServerLogger } from '@/logging'

const logger = getServerLogger()

export function createBareKitRPCServer() {
  const { IPC } = (globalThis as { BareKit?: { IPC: Duplex<DuplexEvents> } }).BareKit!
  return new RPC(IPC, handleRequest)
}

export interface IPCClientOptions {
  onDisconnect?: () => void
}

/**
 * Dial the client's IPC endpoint. Two encodings cross the handshake:
 *
 * - `tcp://host:port` — a loopback TCP endpoint. Used by clients whose
 *   runtime has no portable server for filesystem sockets, notably the
 *   Python `asyncio` transport (`start_unix_server` is Unix-only, and
 *   asyncio has no cross-platform named-pipe server). One code path on
 *   every OS, so Windows dials the same way Linux/macOS do.
 * - anything else — a filesystem path: a Unix domain socket, or a
 *   `\\.\pipe\...` named pipe on Windows, as the Node client (`node:net`)
 *   creates.
 */
function connectToEndpoint(endpoint: string) {
  if (endpoint.startsWith('tcp://')) {
    const hostPort = endpoint.slice('tcp://'.length)
    const sep = hostPort.lastIndexOf(':')
    const host = hostPort.slice(0, sep)
    const port = Number(hostPort.slice(sep + 1))
    return connect(port, host)
  }
  return connect(endpoint)
}

export function createIPCClient(socketPath: string, options?: IPCClientOptions) {
  logger.info(`Connecting to IPC socket at ${socketPath}`)
  const socket = connectToEndpoint(socketPath)

  socket.on('connect', () => {
    logger.info('Connected to IPC server')
  })

  socket.on('error', (err: Error) => {
    logger.error('IPC client connection error:', err)
  })

  socket.on('close', () => {
    logger.warn('IPC socket closed — parent process likely terminated')
    options?.onDisconnect?.()
  })

  return new RPC(socket, handleRequest)
}
