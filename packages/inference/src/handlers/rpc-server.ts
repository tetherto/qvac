import type {
  StartRpcServerRequest,
  StopRpcServerRequest,
  DiscoverRpcServersRequest
} from '@/schemas/rpc-server'
import { getRequestRegistry } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { rpcServers } from '@/rpc/instance'
import { discoverRpcEndpoints } from '@/rpc/discovery'
import { clearRpcServerProvider } from '@/rpc/provider'
import { RpcServerOperationError, InferenceCancelledError } from '@/errors/index'

const requests = new Map<string, Promise<unknown>>()
let closing: Promise<void> | undefined

async function run<T>(operation: string, work: () => Promise<T>): Promise<T> {
  if (closing) throw new RpcServerOperationError(operation, 'Engine is closing')
  try {
    return await work()
  } catch (error) {
    if (error instanceof InferenceCancelledError || error instanceof RpcServerOperationError) {
      throw error
    }
    throw new RpcServerOperationError(
      operation,
      error instanceof Error ? error.message : String(error),
      error
    )
  }
}

async function withContext<T>(
  kind: 'rpcServer' | 'rpcDiscovery',
  work: (ctx: import('@/runtime/request-context').RequestContext) => Promise<T>
): Promise<T> {
  const requestId = generateRandomRequestId()
  const task = (async () => {
    await using ctx = await getRequestRegistry().begin({ requestId, kind })
    return await work(ctx)
  })()
  requests.set(requestId, task)
  try {
    return await task
  } finally {
    requests.delete(requestId)
  }
}

export async function handleStartRpcServer(request: StartRpcServerRequest) {
  return run('startRpcServer', () =>
    withContext('rpcServer', async (ctx) => ({
      type: 'startRpcServer' as const,
      ...(await rpcServers.start(request, ctx))
    }))
  )
}
export async function handleStopRpcServer(request: StopRpcServerRequest) {
  return run('stopRpcServer', async () => {
    await rpcServers.stop(request.serverId)
    return { type: 'stopRpcServer' as const }
  })
}
export async function handleDiscoverRpcServers(request: DiscoverRpcServersRequest) {
  return run('discoverRpcServers', () =>
    withContext('rpcDiscovery', async (ctx) => ({
      type: 'discoverRpcServers' as const,
      servers: await discoverRpcEndpoints(request.topic, request.timeoutMs ?? 5000, ctx)
    }))
  )
}

export function closeRpcResources(): Promise<void> {
  if (closing) return closing
  closing = (async () => {
    for (const requestId of requests.keys()) getRequestRegistry().cancel({ requestId })
    const stopping = rpcServers.close()
    const results = await Promise.allSettled([stopping, ...requests.values()])
    const stopResult = results[0]!
    if (stopResult.status === 'rejected') throw stopResult.reason
    clearRpcServerProvider()
  })()
  return closing.finally(() => {
    closing = undefined
  })
}
