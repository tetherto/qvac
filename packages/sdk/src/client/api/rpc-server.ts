import {
  type StartRpcServerOptions,
  type StopRpcServerOptions,
  type DiscoverRpcServersOptions,
  type RpcServerInfo,
  type RpcServerCandidate
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateClientRequestId } from '@/client/api/client-request-id'

/**
 * Start a worker-owned native TCP server. Non-loopback binding and advertising require explicit opt-in.
 * Cancel a pending start with its promise.requestId.
 */
export function startRpcServer(
  options: StartRpcServerOptions = {}
): Promise<RpcServerInfo> & { requestId: string } {
  const requestId = generateClientRequestId()
  return decoratePromise(runStartRpcServer(options, requestId), { requestId })
}

async function runStartRpcServer(options: StartRpcServerOptions, requestId: string) {
  const response = await send({ ...options, type: 'startRpcServer', requestId })
  if (response.type !== 'startRpcServer') throw new InvalidResponseError('startRpcServer')
  return {
    serverId: response.serverId,
    url: response.url,
    runtime: response.runtime,
    rdmaCapable: response.rdmaCapable
  }
}

/** Withdraw the announcement and await native stop. Bare stop has no deadline. */
export async function stopRpcServer(options: StopRpcServerOptions): Promise<void> {
  const response = await send({ ...options, type: 'stopRpcServer' })
  if (response.type !== 'stopRpcServer') throw new InvalidResponseError('stopRpcServer')
}

/**
 * Find reachable private-network candidates. The caller chooses their order for loadModel.
 * Cancel a pending search with its promise.requestId.
 */
export function discoverRpcServers(
  options: DiscoverRpcServersOptions
): Promise<RpcServerCandidate[]> & { requestId: string } {
  const requestId = generateClientRequestId()
  return decoratePromise(runDiscoverRpcServers(options, requestId), { requestId })
}

async function runDiscoverRpcServers(options: DiscoverRpcServersOptions, requestId: string) {
  const response = await send({ ...options, type: 'discoverRpcServers', requestId })
  if (response.type !== 'discoverRpcServers') throw new InvalidResponseError('discoverRpcServers')
  return response.servers
}
