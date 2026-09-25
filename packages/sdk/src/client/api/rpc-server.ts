import {
  type StartRpcServerOptions,
  type StopRpcServerOptions,
  type DiscoverRpcServersOptions,
  type RpcServerInfo,
  type RpcServerCandidate
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/** Start a worker-owned native TCP server. Non-loopback binding and advertising require explicit opt-in. */
export async function startRpcServer(options: StartRpcServerOptions = {}): Promise<RpcServerInfo> {
  const response = await send({ ...options, type: 'startRpcServer' })
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

/** Find reachable private-network candidates. The caller chooses their order for loadModel. */
export async function discoverRpcServers(
  options: DiscoverRpcServersOptions
): Promise<RpcServerCandidate[]> {
  const response = await send({ ...options, type: 'discoverRpcServers' })
  if (response.type !== 'discoverRpcServers') throw new InvalidResponseError('discoverRpcServers')
  return response.servers
}
