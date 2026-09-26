import type { RequestContext } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { createDisposableScope } from '@/runtime/disposable-scope'
import type { StartRpcServerOptions, RpcServerInfo, RpcServerHandle } from '@/schemas/rpc-server'
import { privateEndpoint, throwIfAborted } from './network'

export type ManagedRpcServer = RpcServerHandle
export interface RpcServerDependencies {
  start(options: StartRpcServerOptions): Promise<ManagedRpcServer>
  ready(server: ManagedRpcServer, ctx: RequestContext): Promise<void>
  advertise(topic: string, url: string): Promise<() => Promise<void>>
}
interface OwnedServer {
  handle: ManagedRpcServer
  active: boolean
  withdraw?: () => Promise<void>
  stopping?: Promise<void>
}

export function createRpcServerManager(deps: RpcServerDependencies) {
  const servers = new Map<string, OwnedServer>()
  const starts = new Set<Promise<RpcServerInfo>>()
  let closing: Promise<void> | undefined

  async function stop(serverId: string): Promise<void> {
    const entry = servers.get(serverId)
    if (!entry) throw new Error(`Unknown RPC server: ${serverId}`)
    if (entry.stopping) return entry.stopping
    entry.stopping = (async () => {
      const errors: unknown[] = []
      if (entry.withdraw) {
        try {
          await entry.withdraw()
          delete entry.withdraw
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await entry.handle.stop()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `Failed to stop RPC server ${serverId}: ${errors.map(String).join('; ')}`,
          { cause: errors[0] }
        )
      }
      servers.delete(serverId)
    })()
    try {
      await entry.stopping
    } finally {
      delete entry.stopping
    }
  }

  async function startOwned(
    options: StartRpcServerOptions,
    ctx: RequestContext
  ): Promise<RpcServerInfo> {
    throwIfAborted(ctx.signal)
    if (
      options.discoveryTopic &&
      (!options.allowNonLoopbackHost || !privateEndpoint(`${options.host}:1`))
    ) {
      throw new Error(
        'RPC advertising requires a concrete private IPv4 host and allowNonLoopbackHost: true'
      )
    }
    await using scope = createDisposableScope()
    const handle = await deps.start(options)
    const serverId = generateRandomRequestId()
    const entry: OwnedServer = { handle, active: false }
    servers.set(serverId, entry)
    let transferred = false
    scope.defer(async () => {
      if (!transferred) await stop(serverId)
    })
    throwIfAborted(ctx.signal)
    await deps.ready(handle, ctx)
    throwIfAborted(ctx.signal)
    if (closing) throw new Error('RPC server manager is closing')
    if (options.discoveryTopic) {
      entry.withdraw = await deps.advertise(options.discoveryTopic, handle.url)
    }
    throwIfAborted(ctx.signal)
    if (closing) throw new Error('RPC server manager is closing')
    entry.active = true
    transferred = true
    return { serverId, url: handle.url, runtime: handle.runtime, rdmaCapable: handle.rdmaCapable }
  }

  function start(options: StartRpcServerOptions, ctx: RequestContext): Promise<RpcServerInfo> {
    if (closing) return Promise.reject(new Error('RPC server manager is closing'))
    const task = startOwned(options, ctx)
    starts.add(task)
    void task.then(
      () => starts.delete(task),
      () => starts.delete(task)
    )
    return task
  }

  function close(): Promise<void> {
    if (closing) return closing
    closing = (async () => {
      // Start every known stop before waiting for starts that may be rolling back.
      const initialIds = new Set([...servers].filter(([, entry]) => entry.active).map(([id]) => id))
      const stopping = Promise.allSettled([...initialIds].map(stop))
      await Promise.allSettled([...starts])
      const lateStops = Promise.allSettled(
        [...servers.keys()].filter((id) => !initialIds.has(id)).map(stop)
      )
      const results = [...(await stopping), ...(await lateStops)]
      const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
      if (errors.length) throw new AggregateError(errors, 'Failed to stop owned RPC servers')
    })()
    return closing.finally(() => {
      closing = undefined
    })
  }

  return {
    start,
    stop,
    close,
    get size() {
      return servers.size
    }
  }
}
