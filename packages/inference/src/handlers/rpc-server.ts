import type {
  StartRpcServerRequest,
  StopRpcServerRequest,
  RpcServerStatusStreamRequest,
  RpcServerStatusStreamResponse,
  RpcServerStatus,
  DiscoverRpcServersRequest
} from '@/schemas/rpc-server'
import type { StreamHandlerContext } from '@/handlers/types'
import { getRequestRegistry } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { rpcServers } from '@/rpc/instance'
import { discoverRpcEndpoints } from '@/rpc/discovery'
import { clearRpcServerProvider } from '@/rpc/provider'
import {
  RpcServerOperationError,
  InferenceCancelledError,
  RequestIdConflictError
} from '@/errors/index'

const requests = new Map<Promise<unknown>, string>()
let closing: Promise<void> | undefined

async function run<T>(operation: string, work: () => Promise<T>): Promise<T> {
  if (closing) throw new RpcServerOperationError(operation, 'Engine is closing')
  try {
    return await work()
  } catch (error) {
    if (
      error instanceof InferenceCancelledError ||
      error instanceof RpcServerOperationError ||
      error instanceof RequestIdConflictError
    ) {
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
  requestId: string,
  work: (ctx: import('@/runtime/request-context').RequestContext) => Promise<T>
): Promise<T> {
  const task = (async () => {
    await using ctx = await getRequestRegistry().begin({ requestId, kind })
    return await work(ctx)
  })()
  requests.set(task, requestId)
  try {
    return await task
  } catch (error) {
    if (error instanceof InferenceCancelledError) {
      throw new InferenceCancelledError(requestId, error.partial, error)
    }
    throw error
  } finally {
    requests.delete(task)
  }
}

export async function handleStartRpcServer(request: StartRpcServerRequest) {
  return run('startRpcServer', () =>
    withContext('rpcServer', request.requestId ?? generateRandomRequestId(), async (ctx) => ({
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
    withContext('rpcDiscovery', request.requestId ?? generateRandomRequestId(), async (ctx) => ({
      type: 'discoverRpcServers' as const,
      servers: await discoverRpcEndpoints(
        request.topic,
        request.timeoutMs ?? 5000,
        ctx,
        undefined,
        request.lanAddresses
      )
    }))
  )
}

export function closeRpcResources(): Promise<void> {
  if (closing) return closing
  closing = (async () => {
    for (const requestId of requests.values()) getRequestRegistry().cancel({ requestId })
    const stopping = rpcServers.close()
    const results = await Promise.allSettled([stopping, ...requests.keys()])
    const stopResult = results[0]!
    if (stopResult.status === 'rejected') throw stopResult.reason
    clearRpcServerProvider()
  })()
  return closing.finally(() => {
    closing = undefined
  })
}

/** Keep pending status delivery bounded and report subscriber overflow explicitly. */
export async function* handleRpcServerStatusStream(
  request: RpcServerStatusStreamRequest,
  { signal }: StreamHandlerContext = {},
  manager: Pick<typeof rpcServers, 'subscribe'> = rpcServers
): AsyncGenerator<RpcServerStatusStreamResponse> {
  if (signal?.aborted) return
  const updates: RpcServerStatus[] = []
  let overflow = false
  let wake: (() => void) | undefined
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const unsubscribe = manager.subscribe((status) => {
    if (request.serverId && request.serverId !== status.serverId) return
    if (updates.length >= 256) overflow = true
    else updates.push(status)
    notify()
  })
  const abort = () => {
    unsubscribe()
    updates.length = 0
    notify()
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (!signal?.aborted) {
      while (updates.length) {
        if (overflow) {
          throw new RpcServerOperationError(
            'rpcServerStatusStream',
            'Status subscriber exceeded 256 pending updates; subscribe again for current state'
          )
        }
        yield { ...updates.shift()!, type: 'rpcServerStatusStream' }
      }
      if (signal?.aborted) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    unsubscribe()
  }
}
